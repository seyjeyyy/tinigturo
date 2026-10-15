import type { AlignmentResult, FinalWordStatus } from '../alignment/aligner';
import { ALIGNER_VERSION } from '../alignment/aligner';
import { NORMALIZER_VERSION } from '../text/normalize';

/**
 * Scoring rules (full description in docs/SCORING.md). Bump SCORING_VERSION whenever a
 * rule changes so stored results stay reproducible.
 *
 * - Evaluated words: passage words inside the attempted region with an outcome
 *   (correct, self-corrected, uncertain, substituted, skipped). Words jumped over with
 *   "Continue from here" and words never reached are not evaluated.
 * - Correct words: exact transcript matches (homophones and number words included)
 *   plus self-corrections. Uncertain words are NOT counted as correct or as errors.
 * - Repetitions and insertions are neither credited nor penalized.
 * - Coverage = evaluated / total. An attempt is complete at >= 95% coverage.
 * - Assessed time uses the assessment clock, which stops during explicit pauses and
 *   app-generated interruptions (app hidden, recognizer restarting). Natural hesitation
 *   is kept. For complete attempts, time stops when the last passage word was reached.
 * - CWPM = correct words / assessed minutes, only when assessed time >= 10 s.
 * - Duration never determines accuracy or completion.
 * - 1.1.0: an attempt whose recognition stopped and did not recover always needs
 *   review; with no words recognized it is unassessed as `recognition_failed` (not
 *   `no_speech_detected`) when the recognizer failed or the microphone picked up voice.
 */
export const SCORING_VERSION = 'score-1.1.0';
export const COMPLETE_COVERAGE = 0.95;
export const MIN_CWPM_MS = 10_000;

export type AssessmentStatus = 'assessed' | 'needs_review' | 'unassessed';
export type Completion = 'complete' | 'partial' | 'unknown';
export type AssessmentMethod =
  | 'transcript_alignment_live'
  | 'transcript_alignment_recording'
  | 'teacher_review'
  | 'none';

export type ReviewReason =
  | 'many_uncertain_words'
  | 'recognition_interrupted'
  | 'low_match_rate'
  | 'too_few_words';

export type UnassessedReason =
  | 'recognition_unavailable'
  | 'language_not_verified'
  | 'no_speech_detected'
  | 'listen_mode'
  | 'recognition_failed';

export interface AttemptTiming {
  /** Recording time, excluding explicit pauses and interruptions. */
  activeMs: number;
  /** Time spent explicitly paused by the reader. */
  pausedMs: number;
  /** App-generated interruptions (backgrounded app, recognizer restart gaps). */
  interruptedMs: number;
  /** Assessment clock: time the recognizer was listening while recording. */
  assessedMs: number;
}

export interface EngineInfo {
  id: string;
  version: string;
  processing: 'on_device' | 'cloud';
}

export interface AssessmentSummary {
  scoringVersion: string;
  alignerVersion: string | null;
  normalizerVersion: number;
  method: AssessmentMethod;
  engine: EngineInfo | null;
  status: AssessmentStatus;
  completion: Completion;
  unassessedReason: UnassessedReason | null;
  reviewReasons: ReviewReason[];
  totalWords: number;
  evaluatedWords: number;
  correctWords: number;
  selfCorrectedWords: number;
  uncertainWords: number;
  substitutedWords: number;
  skippedWords: number;
  unassessedWords: number;
  notReachedWords: number;
  insertions: number;
  repetitions: number;
  coverage: number;
  practiceMs: number;
  assessedMs: number | null;
  cwpm: number | null;
}

export interface WordResult {
  index: number;
  status: FinalWordStatus;
  heard: string | null;
}

const EVALUATED: ReadonlySet<FinalWordStatus> = new Set([
  'correct', 'self_corrected', 'uncertain', 'substituted', 'skipped',
]);

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function countStatuses(statuses: readonly FinalWordStatus[]) {
  const counts = {
    correct: 0, self_corrected: 0, uncertain: 0, substituted: 0, skipped: 0, unassessed: 0, not_reached: 0,
  } satisfies Record<FinalWordStatus, number>;
  for (const status of statuses) counts[status]++;
  return counts;
}

export function computeCwpm(correctWords: number, assessedMs: number | null): number | null {
  if (assessedMs === null || assessedMs < MIN_CWPM_MS) return null;
  return roundTo(correctWords / (assessedMs / 60_000), 1);
}

export function unassessedSummary(
  totalWords: number,
  timing: AttemptTiming,
  reason: UnassessedReason,
  engine: EngineInfo | null = null,
): AssessmentSummary {
  return {
    scoringVersion: SCORING_VERSION,
    alignerVersion: null,
    normalizerVersion: NORMALIZER_VERSION,
    method: 'none',
    engine,
    status: 'unassessed',
    completion: 'unknown',
    unassessedReason: reason,
    reviewReasons: [],
    totalWords,
    evaluatedWords: 0,
    correctWords: 0,
    selfCorrectedWords: 0,
    uncertainWords: 0,
    substitutedWords: 0,
    skippedWords: 0,
    unassessedWords: 0,
    notReachedWords: 0,
    insertions: 0,
    repetitions: 0,
    coverage: 0,
    practiceMs: Math.round(timing.activeMs),
    assessedMs: null,
    cwpm: null,
  };
}

export function summarizeStatuses(input: {
  statuses: readonly FinalWordStatus[];
  timing: AttemptTiming;
  method: AssessmentMethod;
  engine: EngineInfo | null;
  insertions?: number;
  repetitions?: number;
  lastProgressAt?: number | null;
  /** Recognition stopped during the attempt and did not recover. */
  recognitionInterrupted?: boolean;
}): AssessmentSummary {
  const { statuses, timing, method, engine } = input;
  const totalWords = statuses.length;
  const counts = countStatuses(statuses);
  const correctWords = counts.correct + counts.self_corrected;
  const evaluatedWords = statuses.filter((s) => EVALUATED.has(s)).length;
  const coverage = totalWords === 0 ? 0 : roundTo(evaluatedWords / totalWords, 4);
  const completion: Completion = coverage >= COMPLETE_COVERAGE ? 'complete' : 'partial';

  let assessedMs = Math.round(timing.assessedMs);
  if (completion === 'complete' && input.lastProgressAt != null) {
    assessedMs = Math.min(assessedMs, Math.round(input.lastProgressAt));
  }

  const reviewReasons: ReviewReason[] = [];
  if (evaluatedWords < 5) reviewReasons.push('too_few_words');
  if (evaluatedWords > 0 && counts.uncertain / evaluatedWords >= 0.2) reviewReasons.push('many_uncertain_words');
  if (evaluatedWords >= 5 && (counts.skipped + counts.substituted) / evaluatedWords >= 0.5) {
    reviewReasons.push('low_match_rate');
  }
  if (method === 'transcript_alignment_live' && (input.recognitionInterrupted || timing.interruptedMs > 2_000)) {
    reviewReasons.push('recognition_interrupted');
  }

  return {
    scoringVersion: SCORING_VERSION,
    alignerVersion: method === 'teacher_review' ? null : ALIGNER_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    method,
    engine,
    status: reviewReasons.length > 0 ? 'needs_review' : 'assessed',
    completion,
    unassessedReason: null,
    reviewReasons,
    totalWords,
    evaluatedWords,
    correctWords,
    selfCorrectedWords: counts.self_corrected,
    uncertainWords: counts.uncertain,
    substitutedWords: counts.substituted,
    skippedWords: counts.skipped,
    unassessedWords: counts.unassessed,
    notReachedWords: counts.not_reached,
    insertions: input.insertions ?? 0,
    repetitions: input.repetitions ?? 0,
    coverage,
    practiceMs: Math.round(timing.activeMs),
    assessedMs,
    cwpm: computeCwpm(correctWords, assessedMs),
  };
}

/** Builds the assessment for a voice-followed attempt from the aligner's result. */
export function assessAttempt(input: {
  result: AlignmentResult;
  timing: AttemptTiming;
  method: AssessmentMethod;
  engine: EngineInfo;
  /** Recognition stopped during the attempt and did not recover. */
  recognitionInterrupted?: boolean;
  /**
   * The microphone picked up voice for a while. With no recognized words, that points
   * to a recognition problem rather than a silent reader.
   */
  voiceDetected?: boolean;
}): { summary: AssessmentSummary; words: WordResult[] } {
  const { result, timing, method, engine } = input;
  if (result.heardWords === 0) {
    // Never blame the reader for what may be a recognizer failure.
    const reason: UnassessedReason = input.recognitionInterrupted || input.voiceDetected ? 'recognition_failed' : 'no_speech_detected';
    return { summary: unassessedSummary(result.statuses.length, timing, reason, engine), words: [] };
  }
  const summary = summarizeStatuses({
    statuses: result.statuses,
    timing,
    method,
    engine,
    insertions: result.insertions,
    repetitions: result.repetitions,
    lastProgressAt: result.lastProgressAt,
    recognitionInterrupted: input.recognitionInterrupted,
  });
  const words = result.statuses.map((status, index) => ({ index, status, heard: result.heard[index] }));
  return { summary, words };
}

/**
 * Re-scores an attempt after a teacher's manual corrections. The original machine
 * assessment is kept; this produces the reviewed view.
 */
export function rescoreWithCorrections(
  words: readonly WordResult[],
  corrections: ReadonlyMap<number, FinalWordStatus>,
  timing: AttemptTiming,
  original: AssessmentSummary,
): AssessmentSummary {
  const statuses = words.map((w) => corrections.get(w.index) ?? w.status);
  const summary = summarizeStatuses({
    statuses,
    timing: { ...timing, assessedMs: original.assessedMs ?? timing.assessedMs },
    method: 'teacher_review',
    engine: original.engine,
    insertions: original.insertions,
    repetitions: original.repetitions,
  });
  // A teacher's review resolves uncertainty; it is not flagged for review again.
  return { ...summary, status: 'assessed', reviewReasons: [], assessedMs: original.assessedMs, cwpm: computeCwpm(summary.correctWords, original.assessedMs) };
}
