import { describe, expect, it } from 'vitest';
import {
  composeStoryText, groupIntoLines, isPageNumber, joinWrappedLines, linesToParagraphs, normalizeLine,
  plainTextToParagraphs, stripPageFurniture, type PositionedText, type TextLine,
} from './text';
import { BookImportError, bookKind, readBookFile } from './index';
import { MAX_STORY_CHARS } from '../text/tokenize';

const line = (text: string, y: number, x = 72, right = 540): TextLine => ({ text, x, y, height: 12, right });

describe('cleaning text taken from books', () => {
  it('repairs ligatures, soft hyphens and odd spaces without changing the words', () => {
    expect(normalizeLine('The ﬁsh  ﬂoated by­')).toBe('The fish floated by');
  });

  it('recognizes page numbers but not real words', () => {
    for (const t of ['12', '- 12 -', 'Page 3', '4 of 20', 'xiv', 'iv']) expect(isPageNumber(t), t).toBe(true);
    for (const t of ['Civil', 'I am 7.', 'Chapter 2', 'mix']) expect(isPageNumber(t), t).toBe(false);
  });

  it('joins words split across lines, but keeps real hyphens', () => {
    expect(joinWrappedLines(['They used pa-', 'per and a long', 'string.'])).toBe('They used paper and a long string.');
    expect(joinWrappedLines(['a well-', 'Known path'])).toBe('a well- Known path');
  });

  it('groups positioned text into lines, adding spaces only at real gaps', () => {
    const items: PositionedText[] = [
      { str: 'kite.', x: 150, y: 700, width: 30, height: 12 },
      { str: 'The', x: 72, y: 700, width: 20, height: 12 },
      { str: 'red', x: 96, y: 700.4, width: 18, height: 12 },
      { str: 'Next line', x: 72, y: 684, width: 50, height: 12 },
    ];
    expect(groupIntoLines(items).map((l) => l.text)).toEqual(['The red kite.', 'Next line']);
  });

  it('starts paragraphs at wider gaps, indents and short sentence-ending lines', () => {
    const paragraphs = linesToParagraphs([
      line('Ben and his sister made a red kite. They used', 700),
      line('paper and string.', 686, 72, 200),
      line('On Saturday the wind was strong. Ben held the', 672),
      line('string tight.', 658, 72, 160),
      line('The kite flew away!', 630),
    ]);
    expect(paragraphs).toEqual([
      'Ben and his sister made a red kite. They used paper and string.',
      'On Saturday the wind was strong. Ben held the string tight.',
      'The kite flew away!',
    ]);
  });

  it('removes running headers and page numbers set apart at the top or bottom of many pages, and says so', () => {
    const pages = [1, 2, 3, 4].map((n) => [line('The Kite Book', 760), line(`Story text on page ${n}.`, 700), line('More text.', 686), line(String(n), 40)]);
    const result = stripPageFurniture(pages);
    expect(result.pages.map((p) => p.map((l) => l.text))).toEqual([1, 2, 3, 4].map((n) => [`Story text on page ${n}.`, 'More text.']));
    expect(result.removed).toEqual(['The Kite Book']);
  });

  it('keeps a refrain repeated on every page of a picture book', () => {
    const pages = [1, 2, 3, 4].map((n) => [line('Tap, tap, tap.', 700), line(`The rain fell on roof number ${n}.`, 686), line('Tap, tap, tap.', 672)]);
    const result = stripPageFurniture(pages);
    expect(result.pages.every((p) => p.length === 3)).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it('rejoins a paragraph that continues onto the next page and respects the story length limit', () => {
    const composed = composeStoryText([
      { label: 'Page 1', paragraphs: ['First paragraph.', 'The kite went up, up and'] },
      { label: 'Page 2', paragraphs: ['away over the trees.', 'New paragraph.'] },
    ]);
    expect(composed.body).toBe('First paragraph.\n\nThe kite went up, up and away over the trees.\n\nNew paragraph.');
    expect(composed.overLimit).toBe(false);
    expect(composeStoryText([{ label: 'x', paragraphs: ['word '.repeat(MAX_STORY_CHARS / 4)] }]).overLimit).toBe(true);
  });

  it('reads plain text with hard-wrapped lines and blank lines between paragraphs', () => {
    expect(plainTextToParagraphs('One day Pip saw\na big puddle.\r\n\r\nSplash!\n')).toEqual(['One day Pip saw a big puddle.', 'Splash!']);
  });
});

describe('choosing a book file', () => {
  it('knows which files it can read', () => {
    expect(bookKind({ name: 'Kite.PDF', type: '' })).toBe('pdf');
    expect(bookKind({ name: 'book.epub', type: '' })).toBe('epub');
    expect(bookKind({ name: 'notes', type: 'text/plain' })).toBe('text');
    expect(bookKind({ name: 'story.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBeNull();
  });

  it('imports a text file in parts and refuses unsupported or empty files with a clear reason', async () => {
    const paragraphs = Array.from({ length: 23 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const book = await readBookFile(new File([`﻿${paragraphs}`], 'my_story.txt', { type: 'text/plain' }));
    expect(book.title).toBe('my story');
    expect(book.sections.map((s) => s.label)).toEqual(['Part 1 (paragraphs 1–10)', 'Part 2 (paragraphs 11–20)', 'Part 3 (paragraphs 21–23)']);
    expect(book.sections[0].paragraphs[0]).toBe('Paragraph 1.');
    await expect(readBookFile(new File(['x'], 'story.docx'))).rejects.toBeInstanceOf(BookImportError);
    await expect(readBookFile(new File([], 'empty.txt', { type: 'text/plain' }))).rejects.toThrow(/empty/);
  });
});
