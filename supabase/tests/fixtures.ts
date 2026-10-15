import type { PGlite } from '@electric-sql/pglite';
import { as, createUser, rpc, uuid } from './harness';

export const STORY_BODY = 'The cat sat on the mat. The dog ran.';
export const STORY_WORDS = 9;

/** Creates a teacher with one class and a published story. */
export async function setupTeacher(db: PGlite) {
  const teacherId = await createUser(db, { account_type: 'teacher', display_name: 'Teacher' });
  const storyId = uuid();
  const { classId, joinCode, versionId } = await as(db, teacherId, async (tx) => {
    const created = await rpc<{ class_id: string; join_code: string }>(tx, 'create_class', { p_name: 'Grade 2 - Sampaguita', p_grade_level: 2 });
    await tx.query(
      `insert into public.stories (id, owner_id, draft_title, draft_body, language, grade_level, topic)
       values ($1, $2, 'The Cat', $3, 'en', 2, 'Animals')`,
      [storyId, teacherId, STORY_BODY],
    );
    const published = await rpc<{ version_id: string }>(tx, 'publish_story', {
      p_story_id: storyId, p_expected_revision: 1, p_tokenizer_version: 1, p_word_count: STORY_WORDS,
    });
    return { classId: created.class_id, joinCode: created.join_code, versionId: published.version_id };
  });
  return { teacherId, classId, joinCode, storyId, versionId };
}

export async function setupGuardianWithLearner(db: PGlite, name = 'Ana') {
  const guardianId = await createUser(db, { account_type: 'guardian' });
  const learnerId = uuid();
  await as(db, guardianId, (tx) =>
    rpc(tx, 'create_learner', { p_op_id: uuid(), p_learner_id: learnerId, p_display_name: name, p_avatar: 'owl' }),
  );
  return { guardianId, learnerId };
}

export async function enrollAndApprove(db: PGlite, guardianId: string, learnerId: string, teacherId: string, classId: string, joinCode: string) {
  await as(db, guardianId, (tx) => rpc(tx, 'request_class_enrollment', { p_join_code: joinCode, p_learner_id: learnerId }));
  await as(db, teacherId, (tx) => rpc(tx, 'decide_enrollment', { p_class_id: classId, p_learner_id: learnerId, p_approve: true }));
}

export function sessionPayload(overrides: {
  id?: string; learnerId: string; versionId: string; assessed?: boolean; correct?: number; cwpm?: boolean;
  startedAt?: string; localDay?: string; audio?: 'none' | 'local_only' | 'pending';
}) {
  const id = overrides.id ?? uuid();
  const started = overrides.startedAt ?? '2026-10-15T01:00:00.000Z';
  const ended = new Date(new Date(started).getTime() + 60_000).toISOString();
  const assessed = overrides.assessed ?? true;
  const correct = overrides.correct ?? STORY_WORDS;
  const words = Array.from({ length: STORY_WORDS }, (_, i) => ({ i, s: i < correct ? 'correct' : 'substituted', h: i < correct ? null : 'x' }));
  return {
    id,
    learner_id: overrides.learnerId,
    story_version_id: overrides.versionId,
    assignment_id: null,
    mode: 'read_aloud',
    started_at: started,
    ended_at: ended,
    local_day: overrides.localDay ?? '2026-10-15',
    active_ms: 45_000,
    paused_ms: 5_000,
    interrupted_ms: 0,
    assessed_ms: 45_000,
    recognition_plan: assessed ? 'on_device' : 'none',
    transcript: null,
    review_requested: false,
    recovered: false,
    audio_status: overrides.audio ?? 'none',
    assessment: assessed
      ? {
          method: 'transcript_alignment_live', status: 'assessed', completion: 'complete',
          scoring_version: 'score-1.0.0', aligner_version: 'align-1.0.0', normalizer_version: 1,
          engine_id: 'test', engine_version: '1', engine_processing: 'on_device', review_reasons: [],
          total_words: STORY_WORDS, evaluated_words: STORY_WORDS, correct_words: correct, self_corrected_words: 0,
          uncertain_words: 0, substituted_words: STORY_WORDS - correct, skipped_words: 0, unassessed_words: 0,
          not_reached_words: 0, insertions: 0, repetitions: 0, assessed_ms: overrides.cwpm === false ? 5_000 : 30_000,
        }
      : {
          method: 'none', status: 'unassessed', completion: 'unknown', unassessed_reason: 'recognition_unavailable',
          scoring_version: 'score-1.0.0', review_reasons: [], total_words: STORY_WORDS, evaluated_words: 0,
          correct_words: 0, self_corrected_words: 0, uncertain_words: 0, substituted_words: 0, skipped_words: 0,
          unassessed_words: 0, not_reached_words: 0, assessed_ms: null,
        },
    word_results: assessed ? words : [],
  };
}
