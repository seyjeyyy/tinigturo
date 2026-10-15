import { describe, expect, it } from 'vitest';
import { StreamingAligner, type FinalWordStatus } from './aligner';
import { tokenizePassage } from '../text/tokenize';
import type { LanguageCode } from '../text/language';

/**
 * Deterministic transcript fixtures. Each step is a recognizer update:
 * [segmentId, text, isFinal]. Real speech quality must be validated separately on
 * real microphones and devices (docs/TESTING.md).
 */
type Step = [segment: string, text: string, final: boolean] | ['@reposition', number];

function run(passageText: string, steps: Step[], language: LanguageCode = 'en') {
  const passage = tokenizePassage(passageText, language);
  const aligner = new StreamingAligner(passage.words, language);
  let t = 0;
  const snapshots = [];
  for (const step of steps) {
    t += 500;
    if (step[0] === '@reposition') snapshots.push(aligner.reposition(step[1] as number, t));
    else snapshots.push(aligner.update(step[0], step[1] as string, step[2] as boolean, t));
  }
  return { passage, aligner, snapshots, result: aligner.finish() };
}

function statusesOf(result: { statuses: FinalWordStatus[] }) {
  return result.statuses;
}

describe('StreamingAligner — basic following', () => {
  it('confirms words read in order', () => {
    const { result } = run('The cat sat on the mat.', [['a', 'the cat sat on the mat', true]]);
    expect(statusesOf(result)).toEqual(['correct', 'correct', 'correct', 'correct', 'correct', 'correct']);
    expect(result.reachedEnd).toBe(true);
  });

  it('follows the reader pace with partial results and marks partial matches tentative', () => {
    const { snapshots } = run('The cat sat on the mat.', [
      ['a', 'the', false],
      ['a', 'the cat', false],
      ['a', 'the cat sat', true],
      ['b', 'on', false],
    ]);
    expect(snapshots[0].current).toBe(0);
    expect(snapshots[0].words[0]).toEqual({ status: 'correct', tentative: true });
    expect(snapshots[1].nextExpected).toBe(2);
    expect(snapshots[2].words[2]).toEqual({ status: 'correct', tentative: false });
    expect(snapshots[2].confirmedThrough).toBe(2);
    // "on" is a partial: highlighted as current but not confirmed.
    expect(snapshots[3].current).toBe(3);
    expect(snapshots[3].words[3]?.tentative).toBe(true);
    expect(snapshots[3].confirmedThrough).toBe(2);
  });

  it('does not advance when nothing is said (pause keeps the highlight in place)', () => {
    const { snapshots } = run('One small step.', [['a', 'one', true]]);
    expect(snapshots[0].current).toBe(0);
    expect(snapshots[0].nextExpected).toBe(1);
  });

  it('preserves punctuation and spelling in the display while matching normalized text', () => {
    const { passage, result } = run('“Don’t go,” said Niño.', [['a', 'dont go said nino', true]]);
    expect(passage.words.map((w) => w.leading + w.core + w.trailing)).toEqual(['“Don’t', 'go,”', 'said', 'Niño.']);
    expect(result.statuses.every((s) => s === 'correct')).toBe(true);
  });

  it('matches number words and digits', () => {
    const { result } = run('I have 3 red balls.', [['a', 'i have three red balls', true]]);
    expect(result.statuses.every((s) => s === 'correct')).toBe(true);
  });
});

describe('StreamingAligner — revisions to partial transcripts', () => {
  it('re-aligns when a partial result is revised and never double counts', () => {
    const { snapshots, result } = run('The big brown dog ran home.', [
      ['a', 'the big', false],
      ['a', 'the bag', false], // recognizer revises "big" -> "bag"
      ['a', 'the big brown', false], // and back again
      ['a', 'the big brown dog', true],
      ['b', 'ran home', true],
    ]);
    expect(snapshots[1].words[1]?.status).toBe('uncertain');
    expect(snapshots[2].words[1]).toEqual({ status: 'correct', tentative: true });
    expect(result.statuses).toEqual(['correct', 'correct', 'correct', 'correct', 'correct', 'correct']);
  });

  it('a revised partial that shrinks retracts tentative progress but not confirmed progress', () => {
    const { snapshots } = run('Ana has a red hat.', [
      ['a', 'ana has', true],
      ['b', 'a red hat', false],
      ['b', 'a', false],
    ]);
    expect(snapshots[1].current).toBe(4);
    expect(snapshots[2].current).toBe(2);
    expect(snapshots[2].words[3]).toBeNull();
    expect(snapshots[2].words[1]).toEqual({ status: 'correct', tentative: false });
  });

  it('ignores updates to a segment after it became final', () => {
    const { snapshots } = run('Run fast now.', [
      ['a', 'run fast', true],
      ['a', 'something else entirely', false],
    ]);
    expect(snapshots[1].current).toBe(1);
    expect(snapshots[1].heardWords).toBe(2);
  });
});

describe('StreamingAligner — repeated words and phrases', () => {
  it('treats stuttered repetitions as repetitions, not progress', () => {
    const { result } = run('The cat saw the dog.', [['a', 'the the cat saw the dog', true]]);
    expect(result.statuses).toEqual(['correct', 'correct', 'correct', 'correct', 'correct']);
    expect(result.repetitions).toBe(1);
  });

  it('handles a repeated phrase without counting positions twice', () => {
    const { result } = run('I like red. I like blue.', [
      ['a', 'i like red i like red', true],
      ['b', 'i like blue', true],
    ]);
    expect(result.statuses).toEqual(['correct', 'correct', 'correct', 'correct', 'correct', 'correct']);
    expect(result.repetitions).toBeGreaterThanOrEqual(3);
  });

  it('handles passages that repeat the same phrase', () => {
    const { result } = run('Hop, hop, hop! The frog went hop.', [['a', 'hop hop hop the frog went hop', true]]);
    expect(result.statuses.every((s) => s === 'correct')).toBe(true);
  });

  it('does not jump to a distant occurrence of a common word', () => {
    const text = 'Maya ran to the store. She bought milk and bread. Then she walked to the park with the dog.';
    const { snapshots, result } = run(text, [
      ['a', 'maya ran', true],
      ['b', 'she', true], // a stray common word that occurs later in the passage
      ['c', 'the', true], // and one that occurs just ahead
    ]);
    // Without a confirming next word the cursor must stay on "to".
    expect(snapshots[1].nextExpected).toBe(2);
    expect(snapshots[2].nextExpected).toBe(2);
    expect(result.statuses.slice(2).every((s) => s === 'not_reached')).toBe(true);
  });

  it('skips over a word when a common word is confirmed by the next word', () => {
    const { result } = run('Maya ran to the store.', [['a', 'maya ran the store', true]]);
    expect(result.statuses).toEqual(['correct', 'correct', 'skipped', 'correct', 'correct']);
  });
});

describe('StreamingAligner — skips, insertions, substitutions, self-corrections', () => {
  it('marks a skipped word', () => {
    const { result } = run('The big brown dog.', [['a', 'the brown dog', true]]);
    expect(result.statuses).toEqual(['correct', 'skipped', 'correct', 'correct']);
  });

  it('needs a confirming word before skipping over a common word', () => {
    const { result, snapshots } = run('The cat sat on the mat.', [
      ['a', 'the cat sat the', true],
      ['b', 'mat', true],
    ]);
    expect(snapshots[0].nextExpected).toBe(3);
    expect(result.statuses).toEqual(['correct', 'correct', 'correct', 'skipped', 'correct', 'correct']);
  });

  it('accepts a jump over several words when the landing word is distinctive', () => {
    const { result } = run('Maya saw a small green frog near the pond.', [['a', 'maya saw frog near the pond', true]]);
    expect(result.statuses).toEqual([
      'correct', 'correct', 'skipped', 'skipped', 'skipped', 'correct', 'correct', 'correct', 'correct',
    ]);
  });

  it('records a substitution when a different word replaces the expected one', () => {
    const { result } = run('The cat sat down.', [['a', 'the dog sat down', true]]);
    expect(result.statuses).toEqual(['correct', 'substituted', 'correct', 'correct']);
    expect(result.heard[1]).toBe('dog');
  });

  it('marks near-misses as uncertain rather than as mistakes', () => {
    const { result } = run('The rabbit hopped away.', [['a', 'the rabbit hoped away', true]]);
    expect(result.statuses).toEqual(['correct', 'correct', 'uncertain', 'correct']);
  });

  it('credits a self-correction', () => {
    const { result } = run('The cat sat down.', [['a', 'the cap cat sat down', true]]);
    expect(result.statuses).toEqual(['correct', 'self_corrected', 'correct', 'correct']);
  });

  it('credits a self-correction after re-reading a substituted word', () => {
    const { result } = run('The cat sat down.', [['a', 'the dog sat cat sat down', true]]);
    expect(result.statuses[1]).toBe('self_corrected');
    expect(result.statuses.slice(2)).toEqual(['correct', 'correct']);
  });

  it('counts inserted words without moving through the passage', () => {
    const { result } = run('We went home.', [['a', 'we um went to our home', true]]);
    expect(result.statuses).toEqual(['correct', 'correct', 'correct']);
    expect(result.fillers).toBe(1);
    expect(result.insertions).toBe(2);
  });

  it('handles compound splits', () => {
    const { result } = run('Someone knocked.', [['a', 'some one knocked', true]]);
    expect(result.statuses).toEqual(['correct', 'correct']);
  });

  it('treats a different last word as a substitution on finish', () => {
    const { result } = run('This is the end.', [['a', 'this is the and', true]]);
    expect(result.statuses).toEqual(['correct', 'correct', 'correct', 'substituted']);
  });
});

describe('StreamingAligner — silence, noise, and off-script talk', () => {
  it('assesses nothing when nothing was heard (silence)', () => {
    const { result } = run('A short story.', []);
    expect(result.statuses).toEqual(['not_reached', 'not_reached', 'not_reached']);
    expect(result.heardWords).toBe(0);
  });

  it('background noise and unrelated words do not fabricate progress', () => {
    const { result, snapshots } = run('The sun is hot today.', [
      ['a', 'hmm', true],
      ['b', 'beep car honk', true],
      ['c', 'television music playing loudly', true],
    ]);
    expect(snapshots.at(-1)?.current).toBeNull();
    expect(result.statuses.every((s) => s === 'not_reached')).toBe(true);
  });

  it('recovers after off-script talk when reading resumes', () => {
    const { result } = run('The sun is hot today.', [
      ['a', 'the sun', true],
      ['b', 'wait what page is this', true],
      ['c', 'is hot today', true],
    ]);
    expect(result.statuses).toEqual(['correct', 'correct', 'correct', 'correct', 'correct']);
  });

  it('re-synchronizes on a unique three-word phrase after losing the place', () => {
    const text =
      'Lito packed his bag. He took a map, a torch, and a hat. The road to the hill was long and steep. At the top he saw the whole town below.';
    const { result } = run(text, [
      ['a', 'lito packed his bag', true],
      ['b', 'at the top he saw the whole town below', true],
    ]);
    const topIndex = 22; // "At"
    expect(result.statuses[topIndex]).toBe('correct');
    expect(result.statuses.slice(4, topIndex).every((s) => s === 'skipped')).toBe(true);
    expect(result.reachedEnd).toBe(true);
  });
});

describe('StreamingAligner — manual reading-position recovery', () => {
  it('"Continue from here" moves the position without marking skipped words correct', () => {
    const text = 'One two three four five six seven eight nine ten eleven twelve.';
    const { result, snapshots } = run(text, [
      ['a', 'one two', true],
      ['@reposition', 8],
      ['b', 'nine ten eleven twelve', true],
    ]);
    expect(snapshots[1].nextExpected).toBe(8);
    expect(result.statuses.slice(0, 2)).toEqual(['correct', 'correct']);
    expect(result.statuses.slice(2, 8).every((s) => s === 'unassessed')).toBe(true);
    expect(result.statuses.slice(8)).toEqual(['correct', 'correct', 'correct', 'correct']);
  });

  it('moving back allows re-reading without double counting', () => {
    const { result } = run('Red fish blue fish.', [
      ['a', 'red fish blue fish', true],
      ['@reposition', 0],
      ['b', 'red fish blue fish', true],
    ]);
    expect(result.statuses).toEqual(['correct', 'correct', 'correct', 'correct']);
    expect(result.repetitions).toBe(4);
  });

  it('freezes partial text at the moment of repositioning', () => {
    const { result } = run('Alpha beta gamma delta epsilon zeta.', [
      ['a', 'alpha beta', false],
      ['@reposition', 4],
      ['a', 'alpha beta gamma delta', false], // late revision of the old segment is ignored
      ['b', 'epsilon zeta', true],
    ]);
    expect(result.statuses).toEqual(['correct', 'correct', 'unassessed', 'unassessed', 'correct', 'correct']);
  });
});

describe('StreamingAligner — reproducibility', () => {
  it('replaying the stored transcript log reproduces the result', () => {
    const text = 'The cat sat on the mat. Then the cat ran.';
    const { aligner, result, passage } = run(text, [
      ['a', 'the cat', false],
      ['a', 'the cat sat on', true],
      ['@reposition', 6],
      ['b', 'then the cap ran', true],
    ]);
    const replayed = StreamingAligner.fromLog(passage.words, 'en', aligner.log()).finish();
    expect(replayed).toEqual(result);
  });
});

describe('StreamingAligner — Filipino normalization', () => {
  it('normalizes Filipino text with language-aware rules', () => {
    const { result } = run('Si Lola ay nagluto ng adobo.', [['a', 'si lola ay nagluto nang adobo', true]], 'fil');
    expect(result.statuses.every((s) => s === 'correct')).toBe(true);
  });

  it('matches hyphenated Filipino words spoken as one or two words', () => {
    const one = run('Mag-aral tayo.', [['a', 'magaral tayo', true]], 'fil').result;
    const two = run('Mag-aral tayo.', [['a', 'mag aral tayo', true]], 'fil').result;
    expect(one.statuses).toEqual(['correct', 'correct']);
    expect(two.statuses).toEqual(['correct', 'correct']);
  });
});

describe('StreamingAligner — segments a recognizer never finalizes', () => {
  it('an open partial holds back confirmation until it is closed, and closing never re-counts a word', () => {
    const passage = tokenizePassage('The cat sat on the mat.', 'en');
    const aligner = new StreamingAligner(passage.words, 'en');
    aligner.update('a', 'the cat', false, 500);
    aligner.update('b', 'sat on', true, 1000);
    expect(aligner.hasOpenSegment('a')).toBe(true);
    expect(aligner.snapshot().confirmedThrough).toBe(-1); // everything after "a" is still tentative

    const closed = aligner.closeOpenSegments();
    expect(aligner.hasOpenSegment('a')).toBe(false);
    expect(closed.confirmedThrough).toBe(3);
    expect(closed.words.slice(0, 4).every((w) => w?.status === 'correct' && !w.tentative)).toBe(true);

    // A late final for the closed segment is ignored rather than applied twice.
    aligner.update('a', 'the cat the cat', true, 1500);
    const result = aligner.finish();
    expect(result.repetitions).toBe(0);
    expect(result.statuses.slice(0, 4)).toEqual(['correct', 'correct', 'correct', 'correct']);
  });

  it('closed segments are part of the stored log, so replay gives the same result', () => {
    const passage = tokenizePassage('The cat sat on the mat.', 'en');
    const aligner = new StreamingAligner(passage.words, 'en');
    aligner.update('a', 'the cat', false, 500);
    aligner.closeOpenSegments();
    aligner.update('b', 'sat on the mat', true, 1000);
    const replayed = StreamingAligner.fromLog(passage.words, 'en', aligner.log()).finish();
    expect(replayed).toEqual(aligner.finish());
  });
});
