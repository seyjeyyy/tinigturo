import { describe, expect, it } from 'vitest';
import { formatStoryText } from './formatStory';
import { tokenizePassage } from './tokenize';

const words = (text: string) => tokenizePassage(text, 'en').words.map((w) => w.leading + w.core + w.trailing);

// The shape of a poem pasted from a document with paragraph spacing: one blank line
// between lines, several between couplets.
const PASTED_POEM = [
  'Muddy Feet', '', '', '',
  'Shoes are great for tricky jumps,', '', 'Over puddles, logs, or stumps.', '', '', '',
  'Once I laid them on the floor,', '', 'Off I went- out the door.', '', '', '',
  'Just before I reached the grass,', '', 'Down came raindrops, falling fast.',
].join('\n');

describe('automatic story formatting', () => {
  it('turns a pasted poem into stanzas with each line kept on its own line', () => {
    const result = formatStoryText(PASTED_POEM);
    expect(result.text).toBe([
      'Muddy Feet',
      'Shoes are great for tricky jumps,\nOver puddles, logs, or stumps.',
      'Once I laid them on the floor,\nOff I went- out the door.',
      'Just before I reached the grass,\nDown came raindrops, falling fast.',
    ].join('\n\n'));
    expect(result.changed).toBe(true);
    expect(result.notes.join(' ')).toMatch(/4 stanzas/);
    const passage = tokenizePassage(result.text, 'en');
    expect(passage.paragraphs).toHaveLength(4); // was 7 single-line "paragraphs"
    expect(passage.words.find((w) => w.core === 'jumps')?.lineBreakAfter).toBe(true);
  });

  it('joins prose that was broken at the page width, and keeps real paragraphs', () => {
    const wrapped = [
      'Ben and his sister Mia made a red kite out of paper and two long',
      'sticks. They tied a very long string to it and ran to the open',
      'field near the school.',
      '',
      'The wind was strong.',
    ].join('\n');
    const result = formatStoryText(wrapped);
    expect(result.text).toBe('Ben and his sister Mia made a red kite out of paper and two long sticks. They tied a very long string to it and ran to the open field near the school.\n\nThe wind was strong.');
    expect(result.notes.join(' ')).toMatch(/joined into 1 paragraph/);
  });

  it('leaves well-formed text alone, removes extra blank lines, and never changes the words', () => {
    const tidy = 'Pip is a little puppy.\n\nSplash! Pip jumps in the puddle.';
    expect(formatStoryText(tidy)).toEqual({ text: tidy, changed: false, notes: [] });
    const spaced = 'Pip is a little puppy.\n\n\n\n\nSplash!   Pip jumps.\n\n\nThe end.';
    const result = formatStoryText(spaced);
    expect(result.text).toBe('Pip is a little puppy.\n\nSplash! Pip jumps.\n\nThe end.');
    expect(result.notes).toEqual(['Extra blank lines were removed.']);
    for (const input of [PASTED_POEM, spaced]) {
      const once = formatStoryText(input).text;
      expect(words(once)).toEqual(words(input));
      expect(formatStoryText(once).text).toBe(once); // formatting twice changes nothing more
    }
  });

  it('keeps short poem lines typed one per line', () => {
    const verse = 'Tap, tap, tap,\nthe rain is on the roof.\n\nTap, tap, tap,\nit sounds like a song.';
    expect(formatStoryText(verse).changed).toBe(false);
  });
});

describe('poem line breaks in the reading passage', () => {
  it('mark line ends without changing words, IDs or sentences', () => {
    const lines = tokenizePassage('Shoes are great for tricky jumps,\nOver puddles, logs, or stumps.', 'en');
    const flowing = tokenizePassage('Shoes are great for tricky jumps, Over puddles, logs, or stumps.', 'en');
    expect(lines.words.map((w) => [w.id, w.core, w.norm])).toEqual(flowing.words.map((w) => [w.id, w.core, w.norm]));
    expect(lines.sentences.map((s) => s.text)).toEqual(flowing.sentences.map((s) => s.text));
    expect(lines.words.filter((w) => w.lineBreakAfter).map((w) => w.core)).toEqual(['jumps']);
    expect(flowing.words.some((w) => w.lineBreakAfter)).toBe(false);
  });
});
