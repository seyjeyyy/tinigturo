import { describe, expect, it } from 'vitest';
import { tokenizePassage, wordDisplay, sanitizeStoryText } from './tokenize';
import { compareWords, normalizeWord, normalizeTranscript } from './normalize';
import { STARTER_STORIES } from '../content/starterStories';

describe('tokenizePassage', () => {
  it('assigns stable, sequential IDs to words and sentences', () => {
    const a = tokenizePassage('Hello, world! How are you?\n\nFine.', 'en');
    const b = tokenizePassage('Hello, world! How are you?\n\nFine.', 'en');
    expect(a).toEqual(b);
    expect(a.words.map((w) => w.id)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
    expect(a.sentences.map((s) => [s.id, s.wordStart, s.wordEnd])).toEqual([['s0', 0, 2], ['s1', 2, 5], ['s2', 5, 6]]);
    expect(a.paragraphs).toHaveLength(2);
  });

  it('preserves punctuation, quotes and spelling for display', () => {
    const p = tokenizePassage('“Nanay, puwede po ba?” tanong ni Nena.', 'fil');
    expect(p.words.map(wordDisplay)).toEqual(['“Nanay,', 'puwede', 'po', 'ba?”', 'tanong', 'ni', 'Nena.']);
    expect(p.words[0].norm).toBe('nanay');
  });

  it('does not end sentences at common abbreviations', () => {
    const p = tokenizePassage('Mr. Cruz and Dr. Reyes waved. Then they left.', 'en');
    expect(p.sentences).toHaveLength(2);
  });

  it('attaches stray punctuation and dashes to neighbouring words', () => {
    const p = tokenizePassage('Run — fast!\nWait... what?', 'en');
    expect(p.words.map(wordDisplay)).toEqual(['Run —', 'fast!', 'Wait...', 'what?']);
    const joined = tokenizePassage('up—down', 'en');
    expect(joined.words.map((w) => w.core)).toEqual(['up', 'down']);
    expect(joined.words[0].spaceAfter).toBe(false);
  });

  it('strips control characters but never interprets HTML', () => {
    const p = tokenizePassage('<b>Bold</b> text\u0007', 'en');
    expect(p.words.map(wordDisplay)).toEqual(['<b>Bold</b>', 'text']);
    expect(sanitizeStoryText('a\r\nb')).toBe('a\nb');
  });

  it('tokenizes every starter story', () => {
    for (const story of STARTER_STORIES) {
      const p = tokenizePassage(story.body, story.language);
      expect(p.words.length).toBeGreaterThan(20);
      expect(p.words.every((w) => w.norm.length > 0)).toBe(true);
    }
  });
});

describe('normalization', () => {
  it('is language-aware and keeps display text untouched', () => {
    expect(normalizeWord('Don’t', 'en')).toBe('dont');
    expect(normalizeWord('Niño', 'fil')).toBe('nino');
    expect(normalizeWord('3', 'en')).toBe('three');
    expect(normalizeWord('3', 'fil')).toBe('tatlo');
    expect(normalizeTranscript('mag-aral tayo, ngayon!', 'fil')).toEqual(['mag', 'aral', 'tayo', 'ngayon']);
  });

  it('classifies matches without guessing', () => {
    expect(compareWords('two', 'to', 'en')).toBe('exact');
    expect(compareWords('rabbit', 'rabbits', 'en')).toBe('close');
    expect(compareWords('cat', 'dog', 'en')).toBe('none');
    expect(compareWords('nang', 'ng', 'fil')).toBe('exact');
    expect(compareWords('rin', 'din', 'fil')).toBe('close');
  });
});
