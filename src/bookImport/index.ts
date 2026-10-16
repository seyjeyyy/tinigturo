import { BookImportError } from './errors';
import { readEpub } from './epub';
import type { PdfJs } from './pdf';
import type { BookSection } from './text';
import { formatStoryText } from '../text/formatStory';

export { BookImportError } from './errors';
export { composeStoryText, type BookSection, type ComposedText } from './text';

/**
 * Reading a book file a teacher chose, entirely in the browser: nothing is uploaded
 * until the teacher saves the story text they selected.
 */
export type BookKind = 'pdf' | 'epub' | 'text';

export interface BookDocument {
  kind: BookKind;
  title: string;
  /** Pages (PDF), chapters (EPUB) or parts of about ten paragraphs (text files). */
  sections: BookSection[];
  warnings: string[];
}

export const MAX_BOOK_FILE_BYTES = 50 * 1024 * 1024;
export const BOOK_FILE_ACCEPT = '.pdf,.epub,.txt,application/pdf,application/epub+zip,text/plain';

export function bookKind(file: { name: string; type: string }): BookKind | null {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (file.type === 'application/epub+zip' || name.endsWith('.epub')) return 'epub';
  if (file.type === 'text/plain' || name.endsWith('.txt')) return 'text';
  return null;
}

/** File contents as bytes (FileReader where Blob.arrayBuffer is missing, as in older Safari). */
function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 120) || 'Imported story';
}

export async function readBookFile(
  file: File,
  options: { loadPdf?: () => Promise<PdfJs>; onProgress?: (done: number, total: number) => void } = {},
): Promise<BookDocument> {
  const kind = bookKind(file);
  if (!kind) {
    throw new BookImportError('Choose a PDF, an EPUB e-book, or a plain text (.txt) file. A Word document can be saved as PDF first.', 'unsupported');
  }
  if (file.size > MAX_BOOK_FILE_BYTES) throw new BookImportError('This file is larger than 50 MB. Save just the pages you need as a smaller file.', 'too_large');
  if (file.size === 0) throw new BookImportError('This file is empty.', 'empty');
  const fallbackTitle = titleFromFileName(file.name);
  const bytes = await readBytes(file);

  if (kind === 'pdf') {
    const { readPdf, loadPdfJs } = await import('./pdf');
    const { title, sections, warnings } = await readPdf(bytes, fallbackTitle, await (options.loadPdf ?? loadPdfJs)(), options.onProgress);
    return { kind, title, sections, warnings };
  }
  if (kind === 'epub') {
    const { title, sections } = await readEpub(bytes, fallbackTitle);
    return { kind, title, sections, warnings: [] };
  }
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  // The same tidying as pasting: stanzas and poem lines kept, wrapped prose joined.
  const paragraphs = formatStoryText(text).text.split('\n\n').filter(Boolean);
  if (!paragraphs.length) throw new BookImportError('No text was found in this file.', 'empty');
  const sections: BookSection[] = [];
  for (let i = 0; i < paragraphs.length; i += 10) {
    const last = Math.min(paragraphs.length, i + 10);
    sections.push({ label: `Part ${sections.length + 1} (paragraphs ${i + 1}–${last})`, paragraphs: paragraphs.slice(i, last) });
  }
  return { kind, title: fallbackTitle, sections, warnings: [] };
}
