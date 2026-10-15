import type { LanguageCode } from './language';

/**
 * Bump when normalization changes in a way that could change alignment results.
 * Stored with every assessment for reproducibility.
 */
export const NORMALIZER_VERSION = 1;

const NUMBER_WORDS: Record<LanguageCode, readonly string[]> = {
  en: [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
    'nineteen', 'twenty',
  ],
  fil: ['sero', 'isa', 'dalawa', 'tatlo', 'apat', 'lima', 'anim', 'pito', 'walo', 'siyam', 'sampu'],
};

/** Hesitation sounds that recognizers sometimes transcribe. They are never words of a passage. */
const FILLERS: Record<LanguageCode, ReadonlySet<string>> = {
  en: new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'hm']),
  fil: new Set(['um', 'umm', 'uh', 'uhm', 'ah', 'eh', 'hmm', 'mm']),
};

/**
 * Very common words. A common word alone is never enough evidence to jump ahead in
 * the passage, because it probably occurs nearby many times.
 */
const COMMON_WORDS: Record<LanguageCode, ReadonlySet<string>> = {
  en: new Set(
    ('a an and are as at be but by can did do for from go had has have he her him his i ' +
      'in is it its me my no not of on or our out said see she so that the their them then ' +
      'there they this to too two up us was we were what when will with you your').split(' '),
  ),
  fil: new Set(
    ('ako at ay ba din rin hindi ito iyon ka kami ko lang mga mo may na naman ng nang ni niya ' +
      'pa po sa si siya tayo wala ang').split(' '),
  ),
};

/**
 * Spoken-form equivalences. A transcript cannot distinguish homophones, so a reader who
 * says "two" may be transcribed as "to". These are treated as matches; this is a known
 * limitation of transcript-based checking (docs/SCORING.md).
 */
const EQUIVALENT_GROUPS: Record<LanguageCode, readonly string[][]> = {
  en: [
    ['to', 'too', 'two'], ['there', 'their', 'theyre'], ['for', 'four'], ['one', 'won'],
    ['right', 'write'], ['no', 'know'], ['hear', 'here'], ['see', 'sea'], ['be', 'bee'],
    ['by', 'buy', 'bye'], ['ate', 'eight'], ['son', 'sun'], ['flour', 'flower'],
    ['blew', 'blue'], ['knew', 'new'], ['hole', 'whole'], ['road', 'rode'], ['tail', 'tale'],
    ['weak', 'week'], ['wood', 'would'], ['i', 'eye'], ['your', 'youre'],
    ['color', 'colour'], ['gray', 'grey'], ['ok', 'okay'], ['mom', 'mum', 'mommy'],
    ['mr', 'mister'], ['mrs', 'missus'], ['dr', 'doctor'],
  ],
  fil: [
    ['ng', 'nang'],
    ['gng', 'ginang'],
    ['bb', 'binibini'],
  ],
};

/**
 * Pairs that are close but should not be silently accepted: they are marked
 * "uncertain" for review instead of correct.
 */
const CLOSE_GROUPS: Record<LanguageCode, readonly string[][]> = {
  en: [['a', 'the'], ['an', 'a']],
  fil: [['daw', 'raw'], ['din', 'rin'], ['doon', 'roon'], ['dito', 'rito']],
};

function buildIndex(groups: readonly string[][]): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of groups) {
    const canonical = group[0];
    for (const word of group) index.set(word, canonical);
  }
  return index;
}

const EQUIVALENT_INDEX: Record<LanguageCode, Map<string, string>> = {
  en: buildIndex(EQUIVALENT_GROUPS.en),
  fil: buildIndex(EQUIVALENT_GROUPS.fil),
};
const CLOSE_INDEX: Record<LanguageCode, Map<string, string>> = {
  en: buildIndex(CLOSE_GROUPS.en),
  fil: buildIndex(CLOSE_GROUPS.fil),
};

const APOSTROPHES = /['‘’ʼ`´]/g;
const COMBINING_MARKS = /\p{M}+/gu;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Normalizes one word for matching. Display text is never changed; this is only the
 * comparison key. "Don't," -> "dont", "Niño" -> "nino", "3" -> "three" (English).
 */
export function normalizeWord(raw: string, language: LanguageCode): string {
  let word = raw.normalize('NFKC').toLocaleLowerCase(language === 'fil' ? 'fil' : 'en');
  word = word.replace(APOSTROPHES, '');
  word = word.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
  word = word.replace(NON_WORD, '');
  if (/^\d+$/.test(word)) {
    const asNumber = Number.parseInt(word, 10);
    const spelled = NUMBER_WORDS[language][asNumber];
    if (spelled) return spelled;
  }
  return word;
}

/** Splits free transcript text into normalized words, dropping empties. */
export function normalizeTranscript(text: string, language: LanguageCode): string[] {
  const out: string[] = [];
  for (const piece of text.split(/[\s–—-]+/u)) {
    const word = normalizeWord(piece, language);
    if (word) out.push(word);
  }
  return out;
}

/** Comparison key that folds homophones and spelling variants together. */
export function canonicalForm(normalized: string, language: LanguageCode): string {
  return EQUIVALENT_INDEX[language].get(normalized) ?? normalized;
}

export function isFiller(normalized: string, language: LanguageCode): boolean {
  return FILLERS[language].has(normalized);
}

export function isCommonWord(normalized: string, language: LanguageCode): boolean {
  return COMMON_WORDS[language].has(normalized);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

export type MatchKind = 'exact' | 'close' | 'none';

/**
 * Compares a heard word with an expected passage word.
 * - exact: same canonical form (including homophones and number words)
 * - close: plausibly the same word mis-transcribed or partly misread; needs review
 * - none: a different word
 */
export function compareWords(heard: string, expected: string, language: LanguageCode): MatchKind {
  if (!heard || !expected) return 'none';
  if (canonicalForm(heard, language) === canonicalForm(expected, language)) return 'exact';
  const closeHeard = CLOSE_INDEX[language].get(heard);
  if (closeHeard && closeHeard === CLOSE_INDEX[language].get(expected)) return 'close';
  const longest = Math.max(heard.length, expected.length);
  const distance = levenshtein(heard, expected);
  if (longest >= 4 && 1 - distance / longest >= 0.75) return 'close';
  if (longest === 3 && distance === 1 && heard[0] === expected[0]) return 'close';
  return 'none';
}

/** Loose resemblance used to decide whether a false start was an attempt at a word. */
export function resembles(heard: string, expected: string): boolean {
  if (!heard || !expected) return false;
  if (expected.startsWith(heard) && heard.length >= 2) return true;
  const longest = Math.max(heard.length, expected.length);
  return 1 - levenshtein(heard, expected) / longest >= 0.5;
}
