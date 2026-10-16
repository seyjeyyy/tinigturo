import { BookImportError } from './errors';
import { documentLineSpacing, groupIntoLines, linesToParagraphs, stripPageFurniture, type BookSection, type TextLine } from './text';

/**
 * PDF text extraction with Mozilla's PDF.js, loaded only when a teacher imports a PDF
 * (it is not part of the app that learners download). Only text is read: scanned pages
 * (pictures of text) have none, and Tinig Turo does not run OCR, so they are reported
 * instead of guessed.
 */

interface PdfTextItem { str: string; transform: number[]; width: number; height: number }
interface PdfPage { getTextContent(): Promise<{ items: unknown[] }>; cleanup?(): void }
interface PdfDocument {
  numPages: number;
  getMetadata(): Promise<{ info?: unknown }>;
  getPage(n: number): Promise<PdfPage>;
}
export interface PdfJs {
  getDocument(source: { data: Uint8Array; isEvalSupported: boolean; disableFontFace: boolean; verbosity: number }): {
    promise: Promise<PdfDocument>;
    /** Frees the document and its worker. */
    destroy(): Promise<void>;
  };
}

export const MAX_PDF_PAGES = 400;

/** Loads PDF.js and its worker on demand (a separate download of about 1.7 MB). */
export async function loadPdfJs(): Promise<PdfJs> {
  const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib as unknown as PdfJs;
}

const isTextItem = (item: unknown): item is PdfTextItem =>
  typeof (item as PdfTextItem)?.str === 'string' && Array.isArray((item as PdfTextItem).transform);

export async function readPdf(
  data: Uint8Array,
  fallbackTitle: string,
  pdfjs: PdfJs,
  onProgress?: (done: number, total: number) => void,
): Promise<{ title: string; sections: BookSection[]; warnings: string[] }> {
  // isEvalSupported: false keeps PDF.js from compiling font code; only text is needed.
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => undefined);
    if ((error as { name?: string })?.name === 'PasswordException') {
      throw new BookImportError('This PDF is protected with a password. Open it, save a copy without a password, and import that.', 'protected');
    }
    throw new BookImportError('This PDF could not be opened. It may be damaged.', 'damaged');
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new BookImportError(`This PDF has ${doc.numPages} pages. Import at most ${MAX_PDF_PAGES} pages at a time; save the pages you need as a smaller PDF first.`, 'too_large');
    }
    const info = (await doc.getMetadata().catch(() => ({ info: undefined }))).info as { Title?: unknown } | undefined;
    const title = typeof info?.Title === 'string' && info.Title.trim() ? info.Title.trim() : fallbackTitle;
    const pages: TextLine[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(groupIntoLines(content.items.filter(isTextItem).map((item) => ({
        str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height || Math.abs(item.transform[3]),
      }))));
      page.cleanup?.();
      onProgress?.(n, doc.numPages);
    }
    const furniture = stripPageFurniture(pages);
    const spacing = documentLineSpacing(furniture.pages);
    const sections = furniture.pages.map((lines, i) => ({ label: `Page ${i + 1}`, paragraphs: linesToParagraphs(lines, spacing) }));
    const empty = sections.filter((s) => !s.paragraphs.length).length;
    if (empty === sections.length) {
      throw new BookImportError('No text was found in this PDF. It is probably scanned pages (pictures of text), which Tinig Turo cannot read. Use a PDF with selectable text, or type the passage.', 'scanned');
    }
    const warnings = empty ? [`${empty} ${empty === 1 ? 'page has' : 'pages have'} no text (pictures or scanned pages). Their words are not imported.`] : [];
    if (furniture.removed.length) {
      const shown = furniture.removed.slice(0, 3).map((t) => `“${t}”`).join(', ');
      warnings.push(`Left out as a page header or footer repeated on many pages: ${shown}${furniture.removed.length > 3 ? ' and others' : ''}. Add it back in the editor if it is part of the story.`);
    }
    return { title, sections, warnings };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
