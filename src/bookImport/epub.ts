import { BookImportError } from './errors';
import { normalizeLine, type BookSection } from './text';
import { ZipError, ZipReader } from './zip';

/**
 * EPUB e-books: the reading order (spine) of XHTML documents, each turned into
 * paragraphs. Pictures are not imported. Books protected by DRM are refused; font
 * obfuscation alone (common in ordinary EPUBs) is not DRM.
 */

const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dt,dd,figcaption,td,th,div';
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

const xml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
const byLocalName = (doc: Document | Element, name: string) => Array.from(doc.getElementsByTagNameNS('*', name));

function resolvePath(base: string, href: string): string {
  const parts = (base + decodeURIComponent(href.split('#')[0])).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/** Paragraphs of one XHTML document, and its first heading. */
export function xhtmlParagraphs(source: string): { heading: string | null; paragraphs: string[] } {
  let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
  let body: Element | null = doc.querySelector('body');
  if (!body || doc.querySelector('parsererror')) {
    doc = new DOMParser().parseFromString(source, 'text/html');
    body = doc.body;
  }
  if (!body) return { heading: null, paragraphs: [] };
  body.querySelectorAll('script, style').forEach((el) => el.remove());
  let heading: string | null = null;
  const paragraphs: string[] = [];
  for (const el of Array.from(body.querySelectorAll(BLOCKS))) {
    if (el.querySelector(BLOCKS)) continue; // innermost blocks only, so nothing is read twice
    const text = normalizeLine((el.textContent ?? '').replace(/\s+/g, ' '));
    if (!text) continue;
    if (!heading && /^H[1-6]$/.test(el.tagName.toUpperCase())) heading = text;
    paragraphs.push(text);
  }
  if (!paragraphs.length) {
    const text = normalizeLine((body.textContent ?? '').replace(/\s+/g, ' '));
    if (text) paragraphs.push(text);
  }
  return { heading, paragraphs };
}

export async function readEpub(bytes: Uint8Array, fallbackTitle: string): Promise<{ title: string; sections: BookSection[] }> {
  let zip: ZipReader;
  try {
    zip = new ZipReader(bytes);
  } catch (error) {
    throw new BookImportError((error as Error).message, 'damaged');
  }
  const protectedBook = () => new BookImportError('This e-book is protected (DRM), so its text cannot be imported. Use a DRM-free copy, such as a public-domain book.', 'protected');
  if (zip.encrypted || zip.has('META-INF/rights.xml')) throw protectedBook();
  try {
    if (zip.has('META-INF/encryption.xml')) {
      const encryption = xml(await zip.textOf('META-INF/encryption.xml'));
      const algorithms = byLocalName(encryption, 'EncryptionMethod').map((m) => m.getAttribute('Algorithm') ?? '');
      if (algorithms.some((a) => !FONT_OBFUSCATION.has(a))) throw protectedBook();
    }
    if (!zip.has('META-INF/container.xml')) throw new BookImportError('This file is not an EPUB e-book.', 'unsupported');
    const rootPath = byLocalName(xml(await zip.textOf('META-INF/container.xml')), 'rootfile')[0]?.getAttribute('full-path');
    if (!rootPath || !zip.has(rootPath)) throw new BookImportError('This e-book is missing its table of contents.', 'damaged');
    const opf = xml(await zip.textOf(rootPath));
    const base = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : '';
    const title = byLocalName(opf, 'title')[0]?.textContent?.trim() || fallbackTitle;
    const manifest = new Map(byLocalName(opf, 'item').map((item) => [item.getAttribute('id') ?? '', {
      href: item.getAttribute('href') ?? '', type: item.getAttribute('media-type') ?? '',
    }]));
    const sections: BookSection[] = [];
    for (const ref of byLocalName(opf, 'itemref')) {
      if (ref.getAttribute('linear') === 'no') continue;
      const item = manifest.get(ref.getAttribute('idref') ?? '');
      if (!item || !/html/.test(item.type)) continue;
      const path = resolvePath(base, item.href);
      if (!zip.has(path)) continue;
      const { heading, paragraphs } = xhtmlParagraphs(await zip.textOf(path));
      if (!paragraphs.length) continue; // cover pictures and blank pages
      const n = sections.length + 1;
      const name = heading ?? `Section ${n}`;
      sections.push({ label: `${n}. ${name.length > 60 ? `${name.slice(0, 57)}…` : name}`, paragraphs });
      if (sections.length >= 500) break;
    }
    if (!sections.length) throw new BookImportError('No text was found in this e-book.', 'empty');
    return { title, sections };
  } catch (error) {
    if (error instanceof BookImportError) throw error;
    if (error instanceof ZipError) throw new BookImportError(error.message, 'damaged');
    throw new BookImportError('This e-book could not be read.', 'damaged');
  }
}
