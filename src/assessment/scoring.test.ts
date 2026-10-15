import { describe, expect, it } from 'vitest';
import { assessAttempt, computeCwpm, rescoreWithCorrections, summarizeStatuses, unassessedSummary } from './scoring';
import { StreamingAligner, type FinalWordStatus } from '../alignment/aligner';
import { tokenizePassage } from '../text/tokenize';

const engine = { id: 'test', version: '1', processing: 'on_device' as const };
const timing = (assessedMs: number, activeMs = assessedMs) => ({ activeMs, pausedMs: 0, interruptedMs: 0, assessedMs });

describe('scoring rules', () => {
  it('computes CWPM from correct words and assessed minutes only', () => {
    expect(computeCwpm(30, 60_000)).toBe(30);
    expect(computeCwpm(45, 90_000)).toBe(30);
    expect(computeCwpm(10, 9_999)).toBeNull(); // too short to be meaningful
    expect(computeCwpm(10, null)).toBeNull();
  });

  it('never derives accuracy or completion from duration', () => {
    const statuses: FinalWordStatus[] = new Array(20).fill('not_reached');
    const long = summarizeStatuses({ statuses, timing: timing(600_000), method: 'transcript_alignment_live', engine });
    expect(long.correctWords).toBe(0);
    expect(long.completion).toBe('partial');
    expect(long.coverage).toBe(0);
  });

  it('keeps partial attempts partial and separates every measure', () => {
    const statuses: FinalWordStatus[] = [
      'correct', 'correct', 'self_corrected', 'uncertain', 'substituted', 'skipped', 'unassessed', 'unassessed', 'not_reached', 'not_reached',
    ];
    const s = summarizeStatuses({ statuses, timing: timing(30_000), method: 'transcript_alignment_live', engine });
    expect(s).toMatchObject({
      totalWords: 10, evaluatedWords: 6, correctWords: 3, selfCorrectedWords: 1, uncertainWords: 1, substitutedWords: 1,
      skippedWords: 1, unassessedWords: 2, notReachedWords: 2, coverage: 0.6, completion: 'partial', cwpm: 6,
    });
  });

  it('stops the clock at the last word for complete readings', () => {
    const passage = tokenizePassage('One two three four five six.', 'en');
    const aligner = new StreamingAligner(passage.words, 'en');
    aligner.update('a', 'one two three four five six', true, 20_000);
    const { summary } = assessAttempt({ result: aligner.finish(), timing: timing(45_000), method: 'transcript_alignment_live', engine });
    expect(summary.assessedMs).toBe(20_000); // not the 25 s of silence afterwards
    expect(summary.cwpm).toBe(18);
    expect(summary.completion).toBe('complete');
  });

  it('flags uncertain results for review instead of calling them mistakes', () => {
    const statuses: FinalWordStatus[] = ['correct', 'uncertain', 'uncertain', 'correct', 'correct', 'correct'];
    const s = summarizeStatuses({ statuses, timing: timing(20_000), method: 'transcript_alignment_live', engine });
    expect(s.status).toBe('needs_review');
    expect(s.reviewReasons).toContain('many_uncertain_words');
    expect(s.correctWords).toBe(4);
  });

  it('reports no assessment when nothing was heard', () => {
    const passage = tokenizePassage('A quiet room.', 'en');
    const { summary, words } = assessAttempt({ result: new StreamingAligner(passage.words, 'en').finish(), timing: timing(30_000), method: 'transcript_alignment_live', engine });
    expect(summary.status).toBe('unassessed');
    expect(summary.unassessedReason).toBe('no_speech_detected');
    expect(summary.cwpm).toBeNull();
    expect(words).toEqual([]);
  });

  it('unassessed summaries carry no fabricated numbers', () => {
    const s = unassessedSummary(50, timing(0, 40_000), 'recognition_unavailable');
    expect(s).toMatchObject({ status: 'unassessed', completion: 'unknown', correctWords: 0, evaluatedWords: 0, cwpm: null, practiceMs: 40_000 });
  });

  it('teacher corrections produce a reviewed view and keep the original', () => {
    const words = [
      { index: 0, status: 'correct' as const, heard: 'a' },
      { index: 1, status: 'uncertain' as const, heard: 'b' },
      { index: 2, status: 'substituted' as const, heard: 'c' },
    ];
    const original = summarizeStatuses({ statuses: words.map((w) => w.status), timing: timing(12_000), method: 'transcript_alignment_live', engine });
    const reviewed = rescoreWithCorrections(words, new Map([[1, 'correct'], [2, 'correct']]), timing(12_000), original);
    expect(original.correctWords).toBe(1);
    expect(reviewed).toMatchObject({ correctWords: 3, method: 'teacher_review', status: 'assessed', cwpm: 15 });
  });
});
