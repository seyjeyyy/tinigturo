import type { LanguageCode } from './language';
import { normalizeWord } from './normalize';

/**
 * Bump when tokenization changes. Story versions record the tokenizer version so
 * word IDs and positions stay stable for every stored reading attempt.
 */
export const TOKENIZER_VERSION = 1;

export interface PassageWord {
  /** Stable ID within a story version, e.g. "w12". */
  id: string;
  /** 0-based position in the whole passage. */
  index: number;
  sentenceIndex: number;
  paragraphIndex: number;
  /** Punctuation displayed before the word, e.g. an opening quote. */
  leading: string;
  /** The word as written, with original spelling and capitalization. */
  core: string;
  /** Punctuation displayed after the word, e.g. ", or ." */
  trailing: string;
  /** Whether a space follows this word when displayed. */
  spaceAfter: boolean;
  /** Language-aware comparison key. */
  norm: string;
}

export interface PassageSentence {
  id: string;
  index: number;
  paragraphIndex: number;
  wordStart: number;
  wordEnd: number; // exclusive
  /** Plain text of the sentence, used for speech synthesis. */
  text: string;
}

export interface PassageParagraph {
  index: number;
  sentenceStart: number;
  sentenceEnd: number; // exclusive
}

export interface Passage {
  language: LanguageCode;
  tokenizerVersion: number;
  words: PassageWord[];
  sentences: PassageSentence[];
  paragraphs: PassageParagraph[];
}

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'gng', 'bb', 'g', 'sto', 'sta']);
const SENTENCE_END = /[.!?…]/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const LEADING_PUNCT = /^[^\p{L}\p{N}]+/u;
const TRAILING_PUNCT = /[^\p{L}\p{N}]+$/u;
/** Dashes that join two words without spaces: "run—fast". */
const DASH_SPLIT = /([–—]+)/u;

export const MAX_STORY_CHARS = 20_000;

/** Removes control characters and normalizes line endings. Story text is always plain text. */
export function sanitizeStoryText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .normalize('NFC')
    .trim();
}

interface RawToken {
  text: string;
  spaceAfter: boolean;
}

function splitParagraphWords(paragraph: string): RawToken[] {
  const tokens: RawToken[] = [];
  const pieces = paragraph.split(/\s+/u).filter(Boolean);
  for (const piece of pieces) {
    const parts = piece.split(DASH_SPLIT).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLastPart = i === parts.length - 1;
      if (DASH_SPLIT.test(part) && !HAS_WORD_CHAR.test(part)) {
        // A dash between words attaches to the previous word without a space.
        const previous = tokens[tokens.length - 1];
        if (previous) {
          // A free-standing dash ("Run — fast") keeps its space; an embedded one ("up—down") does not.
          previous.text += (parts.length === 1 && previous.spaceAfter ? ' ' : '') + part;
          previous.spaceAfter = isLastPart;
        } else {
          tokens.push({ text: part, spaceAfter: isLastPart });
        }
        continue;
      }
      tokens.push({ text: part, spaceAfter: isLastPart });
    }
  }
  return tokens;
}

/**
 * Converts story text into paragraphs, sentences and words with stable IDs.
 * Pure and deterministic: the same text and tokenizer version always yield the same IDs.
 */
export function tokenizePassage(body: string, language: LanguageCode): Passage {
  const text = sanitizeStoryText(body);
  const words: PassageWord[] = [];
  const sentences: PassageSentence[] = [];
  const paragraphs: PassageParagraph[] = [];

  const paragraphTexts = text.split(/\n\s*\n/u).map((p) => p.trim()).filter(Boolean);

  for (const paragraphText of paragraphTexts) {
    const paragraphIndex = paragraphs.length;
    const sentenceStart = sentences.length;
    let sentenceWordStart = words.length;
    let pendingLeading = '';

    const closeSentence = () => {
      if (words.length === sentenceWordStart) return;
      const sentenceWords = words.slice(sentenceWordStart);
      sentences.push({
        id: `s${sentences.length}`,
        index: sentences.length,
        paragraphIndex,
        wordStart: sentenceWordStart,
        wordEnd: words.length,
        text: sentenceWords.map((w) => w.leading + w.core + w.trailing + (w.spaceAfter ? ' ' : '')).join('').trim(),
      });
      sentenceWordStart = words.length;
    };

    for (const raw of splitParagraphWords(paragraphText)) {
      if (!HAS_WORD_CHAR.test(raw.text)) {
        // Standalone punctuation ("...", "-", a lone quote) attaches to a neighbour.
        const previous = words[words.length - 1];
        if (previous && previous.paragraphIndex === paragraphIndex && words.length > sentenceWordStart) {
          previous.trailing += (previous.spaceAfter ? ' ' : '') + raw.text;
          previous.spaceAfter = raw.spaceAfter;
          if (SENTENCE_END.test(raw.text)) closeSentence();
        } else {
          pendingLeading += raw.text + (raw.spaceAfter ? ' ' : '');
        }
        continue;
      }
      const leading = pendingLeading + (raw.text.match(LEADING_PUNCT)?.[0] ?? '');
      pendingLeading = '';
      const withoutLeading = raw.text.replace(LEADING_PUNCT, '');
      const trailing = withoutLeading.match(TRAILING_PUNCT)?.[0] ?? '';
      const core = trailing ? withoutLeading.slice(0, -trailing.length) : withoutLeading;
      const index = words.length;
      words.push({
        id: `w${index}`,
        index,
        sentenceIndex: sentences.length,
        paragraphIndex,
        leading,
        core,
        trailing,
        spaceAfter: raw.spaceAfter,
        norm: normalizeWord(core, language),
      });
      const endsSentence =
        SENTENCE_END.test(trailing) && !(trailing.startsWith('.') && ABBREVIATIONS.has(normalizeWord(core, language)));
      if (endsSentence) closeSentence();
    }
    closeSentence();
    paragraphs.push({ index: paragraphIndex, sentenceStart, sentenceEnd: sentences.length });
  }

  // Sentence indices were assigned while sentences were still open; fix them up.
  for (const sentence of sentences) {
    for (let i = sentence.wordStart; i < sentence.wordEnd; i++) words[i].sentenceIndex = sentence.index;
  }

  return { language, tokenizerVersion: TOKENIZER_VERSION, words, sentences, paragraphs };
}

export function wordDisplay(word: PassageWord): string {
  return word.leading + word.core + word.trailing;
}
