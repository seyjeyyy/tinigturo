import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { as, createDatabase, createUser, rpc, uuid } from './harness';
import { enrollAndApprove, sessionPayload, setupGuardianWithLearner, setupTeacher, STORY_WORDS } from './fixtures';

let db: PGlite;
beforeAll(async () => {
  db = await createDatabase();
});

const CRITERIA = [
  { key: 'accuracy', label: 'Accuracy', levels: [{ value: 1, label: 'Beginning' }, { value: 2, label: 'Developing' }, { value: 3, label: 'Proficient' }] },
  { key: 'expression', label: 'Expression', levels: [{ value: 1, label: 'Beginning' }, { value: 2, label: 'Developing' }, { value: 3, label: 'Proficient' }] },
];
const FINAL = ['Needs support', 'On track', 'Exceeds'];

/** A teacher, a class with an enrolled learner and one submitted attempt. */
async function classWithAttempt(assessed = true) {
  const t = await setupTeacher(db);
  const g = await setupGuardianWithLearner(db);
  await enrollAndApprove(db, g.guardianId, g.learnerId, t.teacherId, t.classId, t.joinCode);
  const payload = sessionPayload({ learnerId: g.learnerId, versionId: t.versionId, assessed });
  await as(db, g.guardianId, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: JSON.stringify(payload) }));
  const rubric = await as(db, t.teacherId, (tx) => rpc<{ id: string; family_id: string }>(tx, 'create_grading_rubric', {
    p_class_id: t.classId, p_name: 'Oral reading', p_criteria: JSON.stringify(CRITERIA), p_final_levels: JSON.stringify(FINAL),
  }));
  return { ...t, ...g, sessionId: payload.id, rubricId: rubric.id, familyId: rubric.family_id };
}

function grade(tx: Parameters<Parameters<typeof as>[2]>[0], args: {
  sessionId: string; rubricId: string; levels?: Record<string, number>; final?: string | null; publish?: boolean; reason?: string; expected?: number; feedback?: string;
}) {
  return rpc<{ id: string; revision: number; status: string }>(tx, 'save_session_grade', {
    p_session_id: args.sessionId, p_rubric_id: args.rubricId, p_criterion_levels: JSON.stringify(args.levels ?? {}),
    p_final_level: args.final ?? null, p_feedback: args.feedback ?? '', p_publish: args.publish ?? false,
    p_reason: args.reason ?? '', p_expected_revision: args.expected ?? 0,
  });
}

describe('grading rubrics', () => {
  it('are created by class staff only, validated, and versioned without changing old versions', async () => {
    const c = await classWithAttempt();
    const stranger = await setupTeacher(db);
    await expect(as(db, stranger.teacherId, (tx) => rpc(tx, 'create_grading_rubric', {
      p_class_id: c.classId, p_name: 'X', p_criteria: JSON.stringify(CRITERIA), p_final_levels: JSON.stringify(FINAL),
    }))).rejects.toThrow(/only staff of this class/);
    await expect(as(db, c.teacherId, (tx) => rpc(tx, 'create_grading_rubric', {
      p_class_id: c.classId, p_name: 'Bad', p_criteria: JSON.stringify([{ key: 'Bad Key', label: 'x', levels: [] }]), p_final_levels: JSON.stringify(FINAL),
    }))).rejects.toThrow(/not valid/);

    const v2 = await as(db, c.teacherId, (tx) => rpc<{ version: number }>(tx, 'create_grading_rubric', {
      p_class_id: c.classId, p_name: 'Oral reading', p_criteria: JSON.stringify(CRITERIA), p_final_levels: JSON.stringify(FINAL), p_family_id: c.familyId,
    }));
    expect(v2.version).toBe(2);
    const versions = await as(db, c.teacherId, (tx) => tx.query<{ version: number; retired: boolean }>(
      'select version, retired_at is not null as retired from public.grading_rubrics where family_id = $1 order by version', [c.familyId]));
    expect(versions.rows).toEqual([{ version: 1, retired: true }, { version: 2, retired: false }]);
    await expect(as(db, c.teacherId, (tx) => tx.query(`update public.grading_rubrics set name = 'Changed' where id = $1`, [c.rubricId]))).rejects.toThrow(/permission denied/);
    await expect(db.query(`update public.grading_rubrics set name = 'Changed' where id = $1`, [c.rubricId])).rejects.toThrow(/immutable/);
  });
});

describe('teacher grades', () => {
  it('go from draft to published with reviewer identity, and drafts stay with the teacher', async () => {
    const c = await classWithAttempt();
    const draft = await as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 2 }, feedback: 'Good start' }));
    expect(draft).toMatchObject({ revision: 1, status: 'draft' });
    expect((await as(db, c.guardianId, (tx) => tx.query('select * from public.session_grades'))).rows).toEqual([]);

    await expect(as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 2 }, final: 'On track', publish: true, expected: 1 })))
      .rejects.toThrow(/every criterion and the final grade/);
    await expect(as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 9 }, expected: 1 })))
      .rejects.toThrow(/not part of this rubric/);
    await expect(as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 2, expression: 3 }, final: 'A+', publish: true, expected: 1 })))
      .rejects.toThrow(/final grade is not one of/);

    const published = await as(db, c.teacherId, (tx) => grade(tx, {
      sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 2, expression: 3 }, final: 'On track', publish: true, expected: 1, feedback: 'Lovely expression',
    }));
    expect(published).toMatchObject({ revision: 2, status: 'published' });
    const seen = await as(db, c.guardianId, (tx) => tx.query<{ final_level: string; graded_by: string; published_by: string; feedback: string }>(
      'select final_level, graded_by, published_by, feedback from public.session_grades'));
    expect(seen.rows).toEqual([{ final_level: 'On track', graded_by: c.teacherId, published_by: c.teacherId, feedback: 'Lovely expression' }]);
    // The family sees the published grade, not the drafting history.
    expect((await as(db, c.guardianId, (tx) => tx.query('select * from public.session_grade_revisions'))).rows).toEqual([]);
  });

  it('changing a published grade needs a reason and the current revision; every change is kept', async () => {
    const c = await classWithAttempt();
    await as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 3, expression: 3 }, final: 'Exceeds', publish: true }));
    await expect(as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 2, expression: 3 }, final: 'On track', expected: 1 })))
      .rejects.toThrow(/a reason is required/);
    await expect(as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 2, expression: 3 }, final: 'On track', expected: 0, reason: 'x' })))
      .rejects.toThrow(/changed by someone else/);
    const revised = await as(db, c.teacherId, (tx) => grade(tx, {
      sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 2, expression: 3 }, final: 'On track', expected: 1, reason: 'Re-listened to the recording',
    }));
    expect(revised).toMatchObject({ revision: 2, status: 'published' }); // stays published
    const history = await as(db, c.teacherId, (tx) => tx.query<{ revision: number; final_level: string; reason: string; changed_by: string }>(
      'select revision, final_level, reason, changed_by from public.session_grade_revisions order by revision'));
    expect(history.rows).toEqual([
      { revision: 1, final_level: 'Exceeds', reason: '', changed_by: c.teacherId },
      { revision: 2, final_level: 'On track', reason: 'Re-listened to the recording', changed_by: c.teacherId },
    ]);
    await expect(db.query('update public.session_grade_revisions set reason = $1', ['tampered'])).rejects.toThrow(/immutable/);
    // The automated result is untouched by grading.
    const assessment = await as(db, c.teacherId, (tx) => tx.query<{ correct_words: number }>('select correct_words from public.session_assessments where session_id = $1', [c.sessionId]));
    expect(assessment.rows[0].correct_words).toBe(STORY_WORDS);
    await expect(as(db, c.teacherId, (tx) => tx.query(`update public.session_grades set final_level = 'Exceeds'`))).rejects.toThrow(/permission denied/);
  });

  it('are invisible to other classes and cannot be written by their teachers or by families', async () => {
    const c = await classWithAttempt();
    await as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 3, expression: 2 }, final: 'On track', publish: true }));
    const other = await setupTeacher(db);
    const otherRubric = await as(db, other.teacherId, (tx) => rpc<{ id: string }>(tx, 'create_grading_rubric', {
      p_class_id: other.classId, p_name: 'Theirs', p_criteria: JSON.stringify(CRITERIA), p_final_levels: JSON.stringify(FINAL),
    }));
    expect((await as(db, other.teacherId, (tx) => tx.query('select * from public.session_grades where session_id = $1', [c.sessionId]))).rows).toEqual([]);
    expect((await as(db, other.teacherId, (tx) => tx.query('select * from public.class_gradebook($1)', [c.classId]))).rows).toEqual([]);
    await expect(as(db, other.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: otherRubric.id, levels: { accuracy: 1, expression: 1 }, final: 'Needs support', publish: true })))
      .rejects.toThrow(/only a teacher of this learner/);
    await expect(as(db, c.guardianId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 3, expression: 3 }, final: 'Exceeds', publish: true, expected: 1, reason: 'x' })))
      .rejects.toThrow(/only a teacher of this learner/);
    await expect(as(db, null, (tx) => tx.query('select * from public.session_grades'))).rejects.toThrow(/permission denied/);
  });

  it('the gradebook lists attempts with grades and shows no numbers for unassessed attempts', async () => {
    const c = await classWithAttempt(false);
    await as(db, c.teacherId, (tx) => grade(tx, { sessionId: c.sessionId, rubricId: c.rubricId, levels: { accuracy: 2 }, feedback: 'Listened to the recording' }));
    const rows = await as(db, c.teacherId, (tx) => tx.query<{ assessment_status: string; coverage: unknown; cwpm: unknown; grade_status: string; rubric_version: number }>(
      'select assessment_status, coverage, cwpm, grade_status, rubric_version from public.class_gradebook($1)', [c.classId]));
    expect(rows.rows).toEqual([{ assessment_status: 'unassessed', coverage: null, cwpm: null, grade_status: 'draft', rubric_version: 1 }]);
  });
});

describe('vocabulary review workflow', () => {
  async function editor() {
    const id = await createUser(db, { account_type: 'teacher' });
    await db.query(`insert into public.user_roles (user_id, role) values ($1, 'content_editor')`, [id]);
    return id;
  }
  function save(tx: Parameters<Parameters<typeof as>[2]>[0], args: { id?: string | null; headword: string; definition: string; syllables?: string; verified?: boolean; expected?: number }) {
    return rpc<{ id: string; version: number; review_status: string }>(tx, 'save_vocabulary_entry', {
      p_id: args.id ?? null, p_language: 'en', p_headword: args.headword, p_normalized: args.headword.toLowerCase(), p_part_of_speech: 'noun',
      p_definition: args.definition, p_example: null, p_syllables: args.syllables ?? null, p_syllables_verified: args.verified ?? false,
      p_expected_version: args.expected ?? 0,
    });
  }

  it('teachers write drafts; only content editors verify syllables, review and publish, in order', async () => {
    const { teacherId } = await setupTeacher(db);
    const editorId = await editor();
    const word = `lantern${Math.random().toString(36).slice(2, 7)}`;
    const draft = await as(db, teacherId, (tx) => save(tx, { headword: word, definition: 'A light you can carry.', syllables: 'lan·tern', verified: true }));
    expect(draft.review_status).toBe('draft');
    const row = await db.query<{ syllables_verified: boolean }>('select syllables_verified from public.vocabulary_entries where id = $1', [draft.id]);
    expect(row.rows[0].syllables_verified).toBe(false); // a teacher's guess is not verification

    await expect(as(db, teacherId, (tx) => rpc(tx, 'set_vocabulary_status', { p_id: draft.id, p_status: 'reviewed', p_expected_version: draft.version }))).rejects.toThrow(/only a content editor/);
    await expect(as(db, editorId, (tx) => rpc(tx, 'set_vocabulary_status', { p_id: draft.id, p_status: 'published', p_expected_version: draft.version }))).rejects.toThrow(/draft to reviewed to published/);
    const reviewed = await as(db, editorId, (tx) => rpc<{ version: number }>(tx, 'set_vocabulary_status', { p_id: draft.id, p_status: 'reviewed', p_expected_version: draft.version }));
    await expect(as(db, editorId, (tx) => rpc(tx, 'set_vocabulary_status', { p_id: draft.id, p_status: 'published', p_expected_version: draft.version }))).rejects.toThrow(/changed by someone else/);
    const published = await as(db, editorId, (tx) => rpc<{ version: number; review_status: string }>(tx, 'set_vocabulary_status', { p_id: draft.id, p_status: 'published', p_expected_version: reviewed.version }));
    expect(published.review_status).toBe('published');
    const final = await db.query<{ reviewed_by: string; published_by: string; version: number }>('select reviewed_by, published_by, version from public.vocabulary_entries where id = $1', [draft.id]);
    expect(final.rows[0]).toMatchObject({ reviewed_by: editorId, published_by: editorId, version: published.version });

    // A teacher cannot change a published entry; an editor's change sends it back to draft.
    await expect(as(db, teacherId, (tx) => save(tx, { id: draft.id, headword: word, definition: 'Changed.', expected: published.version }))).rejects.toThrow(/only a content editor/);
    const edited = await as(db, editorId, (tx) => save(tx, { id: draft.id, headword: word, definition: 'A small lamp you carry.', syllables: 'lan·tern', verified: true, expected: published.version }));
    expect(edited.review_status).toBe('draft');
    const revisions = await as(db, teacherId, (tx) => tx.query<{ version: number }>('select version from public.vocabulary_revisions where entry_id = $1 order by version', [draft.id]));
    expect(revisions.rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });

  it('guardians cannot edit word meanings', async () => {
    const { guardianId } = await setupGuardianWithLearner(db);
    await expect(as(db, guardianId, (tx) => save(tx, { headword: 'kite', definition: 'x' }))).rejects.toThrow(/only teachers and content editors/);
    await expect(as(db, guardianId, (tx) => tx.query(`update public.vocabulary_entries set definition = 'x'`))).resolves.toMatchObject({ affectedRows: 0 });
  });
});

describe('story narration', () => {
  const pathFor = (storyId: string, versionId: string, ext = 'mp3') => `${storyId}/narration/${versionId}/${uuid()}.${ext}`;

  it('needs the uploaded file, a matching path and valid timings, and keeps one active recording per version', async () => {
    const t = await setupTeacher(db);
    const path = pathFor(t.storyId, t.versionId);
    const register = (p: string, timings: unknown = null) => as(db, t.teacherId, (tx) => rpc<string>(tx, 'register_story_narration', {
      p_story_version_id: t.versionId, p_path: p, p_mime_type: 'audio/mpeg', p_size_bytes: 1000, p_duration_ms: 4000,
      p_timings: timings === null ? null : JSON.stringify(timings), p_note: '',
    }));
    await expect(register(path)).rejects.toThrow(/upload the recording/);
    await as(db, t.teacherId, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('story-assets', $1)`, [path]));
    await expect(register(`${uuid()}/narration/${t.versionId}/${uuid()}.mp3`)).rejects.toThrow(/does not match/);
    await expect(register(path, [{ w: 1, s: 500, e: 900 }, { w: 0, s: 900, e: 1200 }])).rejects.toThrow(/not valid/);
    await expect(register(path, [{ w: STORY_WORDS + 3, s: 0, e: 100 }])).rejects.toThrow(/not valid/);
    const first = await register(path, [{ w: 0, s: 0, e: 300 }, { w: 1, s: 300, e: 600 }]);
    expect(first).toBeTruthy();

    const second = pathFor(t.storyId, t.versionId, 'ogg');
    await as(db, t.teacherId, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('story-assets', $1)`, [second]));
    await as(db, t.teacherId, (tx) => rpc(tx, 'register_story_narration', {
      p_story_version_id: t.versionId, p_path: second, p_mime_type: 'audio/ogg', p_size_bytes: 1000, p_duration_ms: null, p_timings: null, p_note: 'No timings',
    }));
    const rows = await db.query<{ status: string; timings_source: string | null }>('select status, timings_source from public.story_narrations where story_version_id = $1 order by created_at', [t.versionId]);
    expect(rows.rows).toEqual([{ status: 'retired', timings_source: 'uploaded_file' }, { status: 'active', timings_source: null }]);
  });

  it('only the story’s editors can add narration; readers of the story can see it', async () => {
    const t = await setupTeacher(db);
    const other = await setupTeacher(db);
    const path = pathFor(t.storyId, t.versionId);
    await expect(as(db, other.teacherId, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('story-assets', $1)`, [path]))).rejects.toThrow(/row-level security/);
    await db.query(`insert into storage.objects (bucket_id, name) values ('story-assets', $1)`, [path]);
    await expect(as(db, other.teacherId, (tx) => rpc(tx, 'register_story_narration', {
      p_story_version_id: t.versionId, p_path: path, p_mime_type: 'audio/mpeg', p_size_bytes: 1000, p_duration_ms: null, p_timings: null, p_note: '',
    }))).rejects.toThrow(/only an editor of this story/);
    await as(db, t.teacherId, (tx) => rpc(tx, 'register_story_narration', {
      p_story_version_id: t.versionId, p_path: path, p_mime_type: 'audio/mpeg', p_size_bytes: 1000, p_duration_ms: null, p_timings: null, p_note: '',
    }));
    // A learner's guardian in the class can read it once the story is assigned; a stranger cannot.
    const g = await setupGuardianWithLearner(db);
    await enrollAndApprove(db, g.guardianId, g.learnerId, t.teacherId, t.classId, t.joinCode);
    expect((await as(db, g.guardianId, (tx) => tx.query('select * from public.story_narrations where story_version_id = $1', [t.versionId]))).rows).toHaveLength(0);
    await as(db, t.teacherId, (tx) => tx.query(
      'insert into public.assignments (class_id, story_id, story_version_id, created_by) values ($1, $2, $3, $4)', [t.classId, t.storyId, t.versionId, t.teacherId]));
    expect((await as(db, g.guardianId, (tx) => tx.query('select * from public.story_narrations where story_version_id = $1', [t.versionId]))).rows).toHaveLength(1);
    expect((await as(db, other.teacherId, (tx) => tx.query('select * from public.story_narrations where story_version_id = $1', [t.versionId]))).rows).toHaveLength(0);
  });
});
