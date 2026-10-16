// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readPdf, type PdfJs } from './pdf';
import { composeStoryText } from './text';
import { makePdf } from '../test/bookFixtures';

/** The real PDF.js (Node build) reading real PDF files made for the test. */
async function pdfjs(): Promise<PdfJs> {
  return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
}

describe('PDF import', () => {
  it('turns pages into paragraphs, joining split words and leaving out page numbers and running headers', async () => {
    const header = 'STORIES FOR READING';
    const data = makePdf([
      [header, '', 'The Red Kite', '', 'Ben and his sister Mia made a red kite. They used pa-', 'per, sticks, and a long string. On Saturday the', '', '', '', '1'],
      [header, '', 'wind was strong. Mia ran across the field.', '', 'The kite went up, up, up into the sky.', '', '', '', '2'],
      [header, '', 'Suddenly, the string slipped.', '', '', '', '3'],
    ], { title: 'Reading Stories' });
    const progress: number[] = [];
    const book = await readPdf(data, 'fallback', await pdfjs(), (done) => progress.push(done));
    expect(book.title).toBe('Reading Stories');
    expect(progress).toEqual([1, 2, 3]);
    expect(book.sections.map((s) => s.label)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(book.sections[0].paragraphs).toEqual([
      'The Red Kite',
      'Ben and his sister Mia made a red kite. They used paper, sticks, and a long string. On Saturday the',
    ]);
    expect(book.warnings.join(' ')).toContain(header); // the teacher is told what was left out

    const story = composeStoryText(book.sections.slice(0, 2)).body;
    expect(story).toBe([
      'The Red Kite',
      'Ben and his sister Mia made a red kite. They used paper, sticks, and a long string. On Saturday the wind was strong. Mia ran across the field.',
      'The kite went up, up, up into the sky.',
    ].join('\n\n'));
    expect(story).not.toMatch(/\b[12]\b|STORIES/);
  });

  it('reports scanned PDFs (no text) instead of guessing, and notes picture-only pages', async () => {
    await expect(readPdf(makePdf([[], []]), 'x', await pdfjs())).rejects.toMatchObject({ kind: 'scanned' });
    const mixed = await readPdf(makePdf([['A page with words.'], []]), 'x', await pdfjs());
    expect(mixed.warnings[0]).toMatch(/1 page has no text/);
  });

  it('explains a damaged file', async () => {
    await expect(readPdf(new TextEncoder().encode('%PDF-1.4 this is not really a pdf'), 'x', await pdfjs())).rejects.toMatchObject({ kind: 'damaged' });
  });
});
