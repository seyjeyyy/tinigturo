import type { ReadingSessionRecord } from '../domain/types';
import type { SessionSubmitPayload } from '../backend/remoteApi';

/** Converts an immutable local attempt into the server's submit_reading_session shape. */
export function buildSessionPayload(session: ReadingSessionRecord, shareAudio: boolean): SessionSubmitPayload {
  if (session.status !== 'saved' || !session.endedAt) {
    throw new Error('Only saved attempts can be synchronized.');
  }
  const a = session.assessment;
  const hasAudio = session.audio.status !== 'none' && session.audio.status !== 'deleted';
  return {
    id: session.id,
    learner_id: session.learnerId,
    story_version_id: session.storyVersionId,
    assignment_id: session.assignmentId,
    mode: session.mode,
    started_at: session.startedAt,
    ended_at: session.endedAt,
    local_day: session.localDay,
    active_ms: Math.round(session.timing.activeMs),
    paused_ms: Math.round(session.timing.pausedMs),
    interrupted_ms: Math.round(session.timing.interruptedMs),
    assessed_ms: Math.round(session.timing.assessedMs),
    recognition_plan: session.recognition.plan,
    transcript: session.transcript,
    review_requested: session.reviewRequested,
    recovered: session.recovered,
    audio_status: hasAudio ? (shareAudio ? 'pending' : 'local_only') : 'none',
    assessment: a
      ? {
          method: a.method === 'teacher_review' ? 'none' : a.method,
          status: a.status,
          completion: a.completion,
          unassessed_reason: a.unassessedReason,
          review_reasons: a.reviewReasons,
          engine_id: a.engine?.id ?? null,
          engine_version: a.engine?.version ?? null,
          engine_processing: a.engine?.processing ?? null,
          scoring_version: a.scoringVersion,
          aligner_version: a.alignerVersion,
          normalizer_version: a.normalizerVersion,
          total_words: a.totalWords,
          evaluated_words: a.evaluatedWords,
          correct_words: a.correctWords,
          self_corrected_words: a.selfCorrectedWords,
          uncertain_words: a.uncertainWords,
          substituted_words: a.substitutedWords,
          skipped_words: a.skippedWords,
          unassessed_words: a.unassessedWords,
          not_reached_words: a.notReachedWords,
          insertions: a.insertions,
          repetitions: a.repetitions,
          assessed_ms: a.assessedMs,
        }
      : { method: 'none', status: 'unassessed', completion: 'unknown', scoring_version: 'none', total_words: 0 },
    word_results: (session.wordResults ?? []).map((w) => ({ i: w.index, s: w.status, h: w.heard })),
  };
}
