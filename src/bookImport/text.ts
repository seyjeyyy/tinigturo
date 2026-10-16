import { MAX_STORY_CHARS, sanitizeStoryText } from '../text/tokenize';

/**
 * Turning text taken from a book into story text. PDFs and e-books carry layout, not
 * paragraphs: lines are hard-wrapped, words are hyphenated across lines, and pages
 * repeat headers, footers and page numbers. These rules undo the common cases. They
 * are heuristics, so a teacher always reviews the result before saving it.
 */

/** A piece of text positioned on a PDF page (PDF coordinates: y grows upwards). */
export interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLine {
  text: string;
  x: number;
  y: number;
  height: number;
  /** Right edge of the line, for spotting short (paragraph-ending) lines. */
  right: number;
}

const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

export function normalizeLine(text: string): string {
  return text
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c)
    .replace(/­/g, '') // soft hyphens
    .replace(/[\t  -   　]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const ROMAN = /^(?:x{0,3})(?:ix|iv|v?i{0,3})$/;

/** Lines that are only a page number: "12", "- 12 -", "Page 12", "12 of 40", "xiv". */
export function isPageNumber(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(?:page\s*)?[-–—\s]*\d{1,4}[-–—\s]*(?:(?:of|\/)\s*\d{1,4})?$/i.test(t)) return true;
  return ROMAN.test(t) && t.length <= 5;
}

/** Groups positioned text into lines, top to bottom, left to right. */
export function groupIntoLines(items: PositionedText[]): TextLine[] {
  const pieces = items.filter((i) => i.str.trim() || i.str === ' ').sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; height: number; parts: PositionedText[] }[] = [];
  for (const item of pieces) {
    const height = item.height || 10;
    const line = lines.find((l) => Math.abs(l.y - item.y) <= Math.max(l.height, height) * 0.5);
    if (line) {
      line.parts.push(item);
      line.height = Math.max(line.height, height);
    } else lines.push({ y: item.y, height, parts: [item] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => {
      const parts = line.parts.sort((a, b) => a.x - b.x);
      let text = '';
      let end = parts[0].x;
      for (const part of parts) {
        const gap = part.x - end;
        if (text && gap > line.height * 0.15 && !/\s$/.test(text) && !/^\s/.test(part.str)) text += ' ';
        text += part.str;
        end = Math.max(end, part.x + part.width);
      }
      return { text: normalizeLine(text), x: parts[0].x, y: line.y, height: line.height, right: end };
    })
    .filter((line) => line.text);
}

/**
 * The first and last line of a page when they stand apart from the text (a clearly
 * larger gap): where page numbers, running headers and footers sit. Lines inside the
 * text are never treated as page furniture, so a refrain repeated on every page of a
 * picture book stays.
 */
function edgeLines(page: TextLine[], lineSpacing: number): Set<number> {
  const edges = new Set<number>();
  if (page.length === 0) return edges;
  if (page.length === 1) {
    if (isPageNumber(page[0].text)) edges.add(0); // a picture page with only its number
    return edges;
  }
  const gaps = page.slice(1).map((line, i) => page[i].y - line.y);
  const apart = (gap: number) => gap > Math.max(lineSpacing * 1.8, page[0].height * 2);
  if (apart(gaps[0])) edges.add(0);
  if (apart(gaps[gaps.length - 1])) edges.add(page.length - 1);
  return edges;
}

/**
 * Ordinary spacing between lines of text across the whole document: the smallest gap
 * between lines, but never less than 0.8 of a line height (so a stray mark close to a
 * line cannot make every gap look large).
 */
export function documentLineSpacing(pages: TextLine[][]): number {
  const heights = pages.flat().map((l) => l.height).sort((a, b) => a - b);
  const height = heights.length ? heights[Math.floor(heights.length / 2)] : 12;
  const gaps = pages.flatMap((page) => page.slice(1).map((line, i) => page[i].y - line.y)).filter((g) => g > 0);
  return gaps.length ? Math.max(Math.min(...gaps), height * 0.8) : height * 1.2;
}

/**
 * Removes page numbers, and running headers and footers: the same line (ignoring
 * numbers) set apart at the top or bottom of many pages. Removed headers are returned
 * so the teacher can be told.
 */
export function stripPageFurniture(pages: TextLine[][]): { pages: TextLine[][]; removed: string[] } {
  const key = (text: string) => text.toLowerCase().replace(/\d+/g, '#');
  const spacing = documentLineSpacing(pages);
  const edges = pages.map((page) => edgeLines(page, spacing));
  const counts = new Map<string, number>();
  pages.forEach((page, p) => {
    for (const k of new Set([...edges[p]].map((i) => key(page[i].text)))) counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  const removed = new Set<string>();
  const cleaned = pages.map((page, p) => page.filter((line, i) => {
    if (!edges[p].has(i)) return true;
    if (isPageNumber(line.text)) return false;
    if (pages.length >= 3 && (counts.get(key(line.text)) ?? 0) >= threshold) {
      removed.add(line.text);
      return false;
    }
    return true;
  }));
  return { pages: cleaned, removed: [...removed] };
}

/** Joins wrapped lines, removing a hyphen that only split a word across lines. */
export function joinWrappedLines(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (!out) out = line;
    else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
    else out += ' ' + line;
  }
  return out;
}

const SENTENCE_END = /[.!?…:;"”’)\]]$/;

/**
 * Splits a page's lines into paragraphs using line spacing, indentation and short lines.
 * Pass the document's line spacing when known: a page of one-line paragraphs has no
 * ordinary gaps of its own to compare with.
 */
export function linesToParagraphs(lines: TextLine[], lineSpacing?: number): string[] {
  if (!lines.length) return [];
  const gaps = lines.slice(1).map((line, i) => lines[i].y - line.y).filter((g) => g > 0).sort((a, b) => a - b);
  // Ordinary line spacing: the lower quartile, so a few wide gaps (headings, paragraph
  // breaks) on a short page do not count as normal spacing.
  const typicalGap = lineSpacing ?? (gaps.length ? gaps[Math.floor((gaps.length - 1) / 4)] : lines[0].height * 1.2);
  const left = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map((l) => l.right));
  const paragraphs: string[][] = [[lines[0].text]];
  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1];
    const line = lines[i];
    const gap = previous.y - line.y;
    const bigGap = gap > typicalGap * 1.45;
    const indented = line.x - left > line.height * 1.2 && SENTENCE_END.test(previous.text);
    const shortEnding = previous.right < left + (right - left) * 0.7 && SENTENCE_END.test(previous.text);
    const newSize = Math.abs(line.height - previous.height) > previous.height * 0.2; // e.g. a heading
    if (bigGap || indented || shortEnding || newSize) paragraphs.push([line.text]);
    else paragraphs[paragraphs.length - 1].push(line.text);
  }
  return paragraphs.map(joinWrappedLines).filter(Boolean);
}

/** Plain text: blank lines separate paragraphs; single line breaks are wrapping. */
export function plainTextToParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => joinWrappedLines(block.split('\n').map(normalizeLine).filter(Boolean)))
    .filter(Boolean);
}

export interface BookSection {
  label: string;
  paragraphs: string[];
}

export interface ComposedText {
  body: string;
  chars: number;
  overLimit: boolean;
}

/**
 * Builds story text from consecutive sections. A paragraph that runs on from one page
 * to the next (no sentence end, next one starts in lower case) is joined back together.
 */
export function composeStoryText(sections: BookSection[]): ComposedText {
  const paragraphs: string[] = [];
  for (const section of sections) {
    section.paragraphs.forEach((paragraph, i) => {
      const previous = paragraphs[paragraphs.length - 1];
      if (i === 0 && previous && !SENTENCE_END.test(previous) && /^\p{Ll}/u.test(paragraph)) {
        paragraphs[paragraphs.length - 1] = joinWrappedLines([previous, paragraph]);
      } else paragraphs.push(paragraph);
    });
  }
  const body = sanitizeStoryText(paragraphs.join('\n\n'));
  return { body, chars: body.length, overLimit: body.length > MAX_STORY_CHARS };
}
