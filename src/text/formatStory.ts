import { joinWrappedLines, normalizeLine } from '../bookImport/text';
import { sanitizeStoryText } from './tokenize';

/**
 * Tidies story text pasted from documents, web pages or e-books into Tinig Turo's
 * format: paragraphs (or poem stanzas) separated by one blank line, and poem lines kept
 * on their own lines inside a stanza.
 *
 * - Text with two sizes of gap (one blank line between lines, more between groups) is
 *   verse copied from a document with paragraph spacing: single gaps become line
 *   breaks inside a stanza, larger gaps separate stanzas.
 * - Prose broken at a fixed width (long lines, most not ending a sentence) is joined
 *   back into paragraphs.
 * - Extra blank lines, odd spaces and ligatures are cleaned up.
 * The words themselves are never changed.
 */
export interface FormatResult {
  text: string;
  changed: boolean;
  /** What was done, for the teacher. */
  notes: string[];
}

const CLAUSE_END = /[.!?…:;"”’)\]]$/;

function isWrappedProse(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const body = lines.slice(0, -1);
  const long = body.filter((l) => l.length >= 50).length / body.length;
  const open = body.filter((l) => !CLAUSE_END.test(l)).length / body.length;
  return long >= 0.7 && open >= 0.5;
}

export function formatStoryText(input: string): FormatResult {
  const original = sanitizeStoryText(input);
  const blocks: { lines: string[]; blanksBefore: number }[] = [];
  let blanks = 0;
  for (const raw of input.replace(/\r\n?/g, '\n').split('\n')) {
    const line = normalizeLine(raw);
    if (!line) {
      blanks++;
      continue;
    }
    if (!blocks.length || blanks > 0) blocks.push({ lines: [line], blanksBefore: blocks.length ? blanks : 0 });
    else blocks[blocks.length - 1].lines.push(line);
    blanks = 0;
  }
  if (!blocks.length) return { text: '', changed: original !== '', notes: [] };

  const notes: string[] = [];
  const gaps = blocks.slice(1).map((b) => b.blanksBefore);
  const shortSingles = blocks.filter((b) => b.lines.length === 1 && b.lines[0].length <= 70).length;
  const spacedVerse = blocks.length >= 4 && shortSingles / blocks.length >= 0.7 && gaps.some((g) => g === 1) && gaps.some((g) => g >= 2);

  let groups: string[][];
  if (spacedVerse) {
    groups = [];
    blocks.forEach((b, i) => {
      if (i === 0 || b.blanksBefore >= 2) groups.push([...b.lines]);
      else groups[groups.length - 1].push(...b.lines);
    });
    notes.push(`Lines were kept together as ${groups.length} ${groups.length === 1 ? 'stanza' : 'stanzas'}.`);
  } else {
    groups = blocks.map((b) => b.lines);
    if (gaps.some((g) => g >= 2)) notes.push('Extra blank lines were removed.');
  }

  let joined = 0;
  const paragraphs = groups.map((lines) => {
    if (isWrappedProse(lines)) {
      joined++;
      return joinWrappedLines(lines);
    }
    return lines.join('\n');
  });
  if (joined) notes.push(`Lines broken by the page width were joined into ${joined} ${joined === 1 ? 'paragraph' : 'paragraphs'}.`);

  const text = sanitizeStoryText(paragraphs.join('\n\n'));
  const changed = text !== original;
  if (changed && !notes.length) notes.push('Spacing was tidied.');
  return { text, changed, notes: changed ? notes : [] };
}
