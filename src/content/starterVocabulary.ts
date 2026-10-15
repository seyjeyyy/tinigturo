import type { VocabularyEntry } from '../domain/types';
import { normalizeWord } from '../text/normalize';
import type { LanguageCode } from '../text/language';

/**
 * Starter vocabulary written for the bundled stories.
 *
 * Every entry is marked `draft` until an educator reviews it (see docs/CONTENT.md).
 * The app shows "Draft definition" for drafts. Syllable divisions are deliberately
 * left empty: they are only shown once a reviewer has verified them, and the app
 * never guesses syllables with a vowel-counting rule.
 */
type Starter = Pick<VocabularyEntry, 'headword' | 'partOfSpeech' | 'definition' | 'example'> & { n: number; language: LanguageCode };

const STARTER: Starter[] = [
  { n: 1, language: 'en', headword: 'puddle', partOfSpeech: 'noun', definition: 'A small pool of water on the ground, often after rain.', example: 'Pip jumps in the puddle.' },
  { n: 2, language: 'en', headword: 'muddy', partOfSpeech: 'adjective', definition: 'Covered with wet, sticky dirt.', example: 'His shoes were muddy after the game.' },
  { n: 3, language: 'en', headword: 'puppy', partOfSpeech: 'noun', definition: 'A young dog.', example: 'The puppy wagged its tail.' },
  { n: 4, language: 'en', headword: 'roof', partOfSpeech: 'noun', definition: 'The top cover of a house or building.', example: 'The rain is on the roof.' },
  { n: 5, language: 'en', headword: 'shiny', partOfSpeech: 'adjective', definition: 'Bright because light bounces off it.', example: 'The wet street is shiny.' },
  { n: 6, language: 'en', headword: 'raincoat', partOfSpeech: 'noun', definition: 'A coat that keeps you dry in the rain.', example: 'Ana wears a yellow raincoat.' },
  { n: 7, language: 'en', headword: 'kite', partOfSpeech: 'noun', definition: 'A light toy that flies in the wind at the end of a long string.', example: 'The kite went up into the sky.' },
  { n: 8, language: 'en', headword: 'string', partOfSpeech: 'noun', definition: 'A thin, long piece of thread or cord.', example: 'Hold the string tight.' },
  { n: 9, language: 'en', headword: 'suddenly', partOfSpeech: 'adverb', definition: 'Very quickly, when you do not expect it.', example: 'Suddenly, the lights went out.' },
  { n: 10, language: 'en', headword: 'field', partOfSpeech: 'noun', definition: 'A wide, open area of land, often covered with grass.', example: 'Mia ran across the field.' },
  { n: 11, language: 'en', headword: 'garden', partOfSpeech: 'noun', definition: 'A place where people grow plants, flowers, or vegetables.', example: 'Lola waters her garden.' },
  { n: 12, language: 'en', headword: 'patience', partOfSpeech: 'noun', definition: 'Being able to wait calmly without getting upset.', example: 'A garden needs patience.' },
  { n: 13, language: 'en', headword: 'soil', partOfSpeech: 'noun', definition: 'The top layer of the ground, where plants grow.', example: 'The soil became dry.' },
  { n: 14, language: 'en', headword: 'caterpillar', partOfSpeech: 'noun', definition: 'A small, soft, worm-like animal that later becomes a butterfly or moth.', example: 'A caterpillar was eating the leaf.' },
  { n: 15, language: 'en', headword: 'weeds', partOfSpeech: 'noun', definition: 'Plants that grow where people do not want them.', example: 'Carlo pulls the weeds.' },
  { n: 16, language: 'en', headword: 'cracked', partOfSpeech: 'adjective', definition: 'Having thin lines where something has started to break.', example: 'The dry ground was cracked.' },
  { n: 17, language: 'en', headword: 'carefully', partOfSpeech: 'adverb', definition: 'Slowly and with attention, so nothing goes wrong.', example: 'He carried the eggs carefully.' },
  { n: 18, language: 'en', headword: 'well', partOfSpeech: 'noun', definition: 'A deep hole in the ground where people get water.', example: 'Carlo carried water from the well.' },
  { n: 19, language: 'fil', headword: 'balahibo', partOfSpeech: 'pangngalan', definition: 'Ang malambot na buhok na tumatakip sa katawan ng hayop.', example: 'Puti ang balahibo ng pusa.' },
  { n: 20, language: 'fil', headword: 'palengke', partOfSpeech: 'pangngalan', definition: 'Lugar kung saan nagtitinda at bumibili ang mga tao ng pagkain at iba pang bagay.', example: 'Sumama si Nena sa palengke.' },
  { n: 21, language: 'fil', headword: 'hinog', partOfSpeech: 'pang-uri', definition: 'Handa nang kainin dahil malambot at matamis na ang prutas.', example: 'Bumili sila ng hinog na mangga.' },
  { n: 22, language: 'fil', headword: 'pinamili', partOfSpeech: 'pangngalan', definition: 'Ang mga bagay na binili sa tindahan o palengke.', example: 'Inayos nila ang mga pinamili.' },
  { n: 23, language: 'fil', headword: 'maaga', partOfSpeech: 'pang-uri', definition: 'Bago ang karaniwang oras.', example: 'Maagang gumising si Nena.' },
];

export const STARTER_VOCABULARY: VocabularyEntry[] = STARTER.map(({ n, ...entry }) => ({
  id: `00000000-0000-4000-8000-${String(300 + n).padStart(12, '0')}`,
  normalized: normalizeWord(entry.headword, entry.language),
  syllables: null,
  syllablesVerified: false,
  reviewStatus: 'draft',
  ...entry,
}));
