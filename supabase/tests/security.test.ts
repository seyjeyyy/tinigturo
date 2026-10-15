import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { as, createDatabase, createUser, rpc, uuid } from './harness';
import { enrollAndApprove, sessionPayload, setupGuardianWithLearner, setupTeacher, STORY_WORDS } from './fixtures';

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
});

async function count(tx: { query: PGlite['query'] }, sql: string, params: unknown[] = []): Promise<number> {
  const result = await tx.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return result.rows[0].n;
}

describe('RLS is enabled everywhere', () => {
  it('every public table has row level security', async () => {
    const result = await db.query<{ tablename: string }>(
      `select c.relname as tablename from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(result.rows).toEqual([]);
  });

  it('anon cannot read any application table or call RPCs', async () => {
    await expect(as(db, null, (tx) => tx.query('select * from public.stories'))).rejects.toThrow(/permission denied/);
    await expect(as(db, null, (tx) => tx.query('select * from public.learners'))).rejects.toThrow(/permission denied/);
    await expect(as(db, null, (tx) => tx.query('select public.my_access()'))).rejects.toThrow(/permission denied/);
  });
});

describe('roles cannot be self-assigned', () => {
  it('a guardian cannot promote themselves by editing their profile or roles', async () => {
    const userId = await createUser(db, { account_type: 'guardian' });
    await expect(
      as(db, userId, (tx) => tx.query(`update public.profiles set requested_account_type = 'teacher' where id = $1`, [userId])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, userId, (tx) => tx.query(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [userId])),
    ).rejects.toThrow(/permission denied/);
    await expect(as(db, userId, (tx) => rpc(tx, 'grant_role', { p_user_id: userId, p_role: 'admin' }))).rejects.toThrow(/only an admin/);
  });

  it('changing user metadata after sign-up does not grant the teacher role', async () => {
    const userId = await createUser(db, { account_type: 'guardian' });
    await db.query(`update auth.users set raw_user_meta_data = '{"account_type":"teacher","role":"admin"}' where id = $1`, [userId]);
    const roles = await as(db, userId, (tx) => tx.query('select role from public.user_roles'));
    expect(roles.rows).toEqual([]);
    await expect(as(db, userId, (tx) => rpc(tx, 'create_class', { p_name: 'Mine' }))).rejects.toThrow(/teacher role is required/);
  });

  it('teacher self sign-up can be turned off by the server setting', async () => {
    await db.query(`update public.app_settings set value = 'false' where key = 'teacher_self_signup'`);
    const userId = await createUser(db, { account_type: 'teacher' });
    const roles = await as(db, userId, (tx) => tx.query('select role from public.user_roles'));
    expect(roles.rows).toEqual([]);
    await db.query(`update public.app_settings set value = 'true' where key = 'teacher_self_signup'`);
  });
});

describe('learner access', () => {
  it('only the guardian who created a learner can read it', async () => {
    const { learnerId } = await setupGuardianWithLearner(db);
    const stranger = await createUser(db);
    const seen = await as(db, stranger, (tx) => count(tx, 'select * from public.learners where id = $1', [learnerId]));
    expect(seen).toBe(0);
  });

  it('nobody can attach themselves to an arbitrary learner ID', async () => {
    const { learnerId } = await setupGuardianWithLearner(db);
    const attacker = await createUser(db);
    await expect(
      as(db, attacker, (tx) => tx.query(`insert into public.learner_access (user_id, learner_id, relation) values ($1, $2, 'guardian')`, [attacker, learnerId])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, attacker, (tx) => rpc(tx, 'create_learner', { p_op_id: uuid(), p_learner_id: learnerId, p_display_name: 'Mine now', p_avatar: 'fox' })),
    ).rejects.toThrow(/not available/);
    const access = await as(db, attacker, (tx) => rpc<{ guardian_learner_ids: string[] }>(tx, 'my_access', {}));
    expect(access.guardian_learner_ids).toEqual([]);
  });

  it('create_learner is idempotent per op id', async () => {
    const guardian = await createUser(db);
    const learnerId = uuid();
    const opId = uuid();
    await as(db, guardian, async (tx) => {
      await rpc(tx, 'create_learner', { p_op_id: opId, p_learner_id: learnerId, p_display_name: 'Ben', p_avatar: 'owl' });
      await rpc(tx, 'create_learner', { p_op_id: opId, p_learner_id: learnerId, p_display_name: 'Ben', p_avatar: 'owl' });
    });
    const n = await as(db, guardian, (tx) => count(tx, 'select * from public.learners where id = $1', [learnerId]));
    expect(n).toBe(1);
  });
});

describe('classes and controlled enrollment', () => {
  it('a class code routes a request but exposes neither the roster nor the code', async () => {
    const { teacherId, classId, joinCode } = await setupTeacher(db);
    const first = await setupGuardianWithLearner(db, 'Lito');
    await enrollAndApprove(db, first.guardianId, first.learnerId, teacherId, classId, joinCode);

    const second = await setupGuardianWithLearner(db, 'Nena');
    const response = await as(db, second.guardianId, (tx) =>
      rpc<{ status: string; class_name: string }>(tx, 'request_class_enrollment', { p_join_code: joinCode.toLowerCase(), p_learner_id: second.learnerId }),
    );
    expect(response.status).toBe('pending');
    expect(response).not.toHaveProperty('learners');

    await as(db, second.guardianId, async (tx) => {
      expect(await count(tx, 'select * from public.class_join_codes')).toBe(0);
      // Other members of the class are invisible.
      expect(await count(tx, 'select * from public.class_memberships where learner_id = $1', [first.learnerId])).toBe(0);
      expect(await count(tx, 'select * from public.learners where id = $1', [first.learnerId])).toBe(0);
      expect(await count(tx, 'select * from public.reading_sessions')).toBe(0);
      // Assignments are not visible while the request is pending.
      expect(await count(tx, 'select * from public.assignments where class_id = $1', [classId])).toBe(0);
    });
  });

  it('a guardian can only request enrollment for their own learner', async () => {
    const { joinCode } = await setupTeacher(db);
    const { learnerId } = await setupGuardianWithLearner(db);
    const attacker = await createUser(db);
    await expect(
      as(db, attacker, (tx) => rpc(tx, 'request_class_enrollment', { p_join_code: joinCode, p_learner_id: learnerId })),
    ).rejects.toThrow(/only enroll learners you look after/);
  });

  it('wrong codes are rate limited', async () => {
    const { learnerId, guardianId } = await setupGuardianWithLearner(db);
    for (let i = 0; i < 10; i++) {
      const result = await as(db, guardianId, (tx) =>
        rpc<{ status: string }>(tx, 'request_class_enrollment', { p_join_code: 'ZZZZZZZZ', p_learner_id: learnerId }),
      );
      expect(result.status).toBe('not_found');
    }
    await expect(
      as(db, guardianId, (tx) => rpc(tx, 'request_class_enrollment', { p_join_code: 'ZZZZZZZZ', p_learner_id: learnerId })),
    ).rejects.toThrow(/too many attempts/);
  });

  it('a teacher sees learner records only after approving the request', async () => {
    const { teacherId, classId, joinCode, versionId } = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    await as(db, guardianId, (tx) =>
      rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: sessionPayload({ learnerId, versionId }) }),
    );
    await as(db, guardianId, (tx) => rpc(tx, 'request_class_enrollment', { p_join_code: joinCode, p_learner_id: learnerId }));

    await as(db, teacherId, async (tx) => {
      // Pending: the teacher can see who asked, but not their reading records.
      expect(await count(tx, 'select * from public.learners where id = $1', [learnerId])).toBe(1);
      expect(await count(tx, 'select * from public.reading_sessions where learner_id = $1', [learnerId])).toBe(0);
    });
    await as(db, teacherId, (tx) => rpc(tx, 'decide_enrollment', { p_class_id: classId, p_learner_id: learnerId, p_approve: true }));
    const visible = await as(db, teacherId, (tx) => count(tx, 'select * from public.reading_sessions where learner_id = $1', [learnerId]));
    expect(visible).toBe(1);
  });

  it('teachers cannot see other classes, their learners, or their attempts', async () => {
    const a = await setupTeacher(db);
    const b = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    await enrollAndApprove(db, guardianId, learnerId, a.teacherId, a.classId, a.joinCode);
    await as(db, guardianId, (tx) =>
      rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: sessionPayload({ learnerId, versionId: a.versionId }) }),
    );
    await as(db, b.teacherId, async (tx) => {
      expect(await count(tx, 'select * from public.classes where id = $1', [a.classId])).toBe(0);
      expect(await count(tx, 'select * from public.class_memberships where class_id = $1', [a.classId])).toBe(0);
      expect(await count(tx, 'select * from public.learners where id = $1', [learnerId])).toBe(0);
      expect(await count(tx, 'select * from public.reading_sessions where learner_id = $1', [learnerId])).toBe(0);
      expect(await count(tx, 'select * from public.class_progress($1)', [a.classId])).toBe(0);
    });
    await expect(
      as(db, b.teacherId, (tx) => rpc(tx, 'decide_enrollment', { p_class_id: a.classId, p_learner_id: learnerId, p_approve: false })),
    ).rejects.toThrow(/not a teacher of this class/);
    await expect(
      as(db, b.teacherId, (tx) => rpc(tx, 'add_assessment_correction', {
        p_session_id: uuid(), p_word_index: 0, p_corrected_status: 'correct', p_reason: 'x',
      })),
    ).rejects.toThrow(/only a teacher of this learner/);
  });

  it('removing a learner from a class revokes the teacher\'s access', async () => {
    const t = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    await enrollAndApprove(db, guardianId, learnerId, t.teacherId, t.classId, t.joinCode);
    await as(db, t.teacherId, (tx) => rpc(tx, 'remove_class_member', { p_class_id: t.classId, p_learner_id: learnerId }));
    const n = await as(db, t.teacherId, (tx) => count(tx, 'select * from public.learners where id = $1', [learnerId]));
    expect(n).toBe(0);
  });
});

describe('reading sessions: idempotent, immutable, validated', () => {
  it('duplicate retries never duplicate sessions or rewards', async () => {
    const { versionId } = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    const opId = uuid();
    const payload = sessionPayload({ learnerId, versionId });
    const first = await as(db, guardianId, (tx) => rpc<{ awards: unknown[] }>(tx, 'submit_reading_session', { p_op_id: opId, p_session: payload }));
    const retry = await as(db, guardianId, (tx) => rpc<{ awards: unknown[] }>(tx, 'submit_reading_session', { p_op_id: opId, p_session: payload }));
    const newOpSameSession = await as(db, guardianId, (tx) =>
      rpc<{ duplicate: boolean }>(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: payload }),
    );
    expect(retry).toEqual(first);
    expect(newOpSameSession.duplicate).toBe(true);
    await as(db, guardianId, async (tx) => {
      expect(await count(tx, 'select * from public.reading_sessions where learner_id = $1', [learnerId])).toBe(1);
      expect(await count(tx, 'select * from public.word_results where session_id = $1', [payload.id])).toBe(STORY_WORDS);
      expect(await count(tx, `select * from public.badge_awards where learner_id = $1 and badge_code = 'first_practice'`, [learnerId])).toBe(1);
      expect(await count(tx, `select * from public.badge_awards where learner_id = $1 and badge_code = 'story_finisher'`, [learnerId])).toBe(1);
    });
  });

  it('sessions cannot be inserted, edited or deleted directly', async () => {
    const { versionId } = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    const payload = sessionPayload({ learnerId, versionId });
    await as(db, guardianId, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: payload }));
    await expect(
      as(db, guardianId, (tx) => tx.query(`update public.reading_sessions set active_ms = 1 where id = $1`, [payload.id])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, guardianId, (tx) => tx.query(`delete from public.reading_sessions where id = $1`, [payload.id])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, guardianId, (tx) => tx.query(`update public.session_assessments set correct_words = 99 where session_id = $1`, [payload.id])),
    ).rejects.toThrow(/permission denied/);
    // Even the table owner cannot change an attempt's content.
    await expect(db.query(`update public.reading_sessions set active_ms = 1 where id = $1`, [payload.id])).rejects.toThrow(/immutable/);
    // A review request is the one permitted change, through its own RPC.
    await as(db, guardianId, (tx) => rpc(tx, 'request_session_review', { p_op_id: uuid(), p_session_id: payload.id }));
    const row = await as(db, guardianId, (tx) => tx.query<{ review_requested: boolean }>('select review_requested from public.reading_sessions where id = $1', [payload.id]));
    expect(row.rows[0].review_requested).toBe(true);
    const stranger = await createUser(db);
    await expect(as(db, stranger, (tx) => rpc(tx, 'request_session_review', { p_op_id: uuid(), p_session_id: payload.id }))).rejects.toThrow(/not found/);
  });

  it('a user cannot submit attempts for a learner they do not look after', async () => {
    const { versionId } = await setupTeacher(db);
    const { learnerId } = await setupGuardianWithLearner(db);
    const attacker = await createUser(db);
    await expect(
      as(db, attacker, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: sessionPayload({ learnerId, versionId }) })),
    ).rejects.toThrow(/not authorized for this learner/);
  });

  it('recomputes CWPM and coverage on the server and rejects inconsistent counts', async () => {
    const { versionId } = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    const good = sessionPayload({ learnerId, versionId, correct: 6 });
    await as(db, guardianId, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: good }));
    const row = await as(db, guardianId, (tx) =>
      tx.query<{ cwpm: string; coverage: string }>('select cwpm, coverage from public.session_assessments where session_id = $1', [good.id]),
    );
    expect(Number(row.rows[0].cwpm)).toBe(12); // 6 correct / 0.5 min
    expect(Number(row.rows[0].coverage)).toBe(1);

    const bad = sessionPayload({ learnerId, versionId });
    bad.assessment.correct_words = 50;
    await expect(
      as(db, guardianId, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: bad })),
    ).rejects.toThrow(/inconsistent|do not match/);
  });

  it('unassessed recordings earn participation but never performance awards', async () => {
    const { versionId } = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    const payload = sessionPayload({ learnerId, versionId, assessed: false });
    const result = await as(db, guardianId, (tx) =>
      rpc<{ awards: { badge_code: string }[] }>(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: payload }),
    );
    const codes = result.awards.map((a) => a.badge_code).sort();
    expect(codes).toEqual(['first_practice', 'practice_day']);
    const stored = await as(db, guardianId, (tx) =>
      tx.query<{ cwpm: string | null; completion: string }>('select cwpm, completion from public.session_assessments where session_id = $1', [payload.id]),
    );
    expect(stored.rows[0]).toEqual({ cwpm: null, completion: 'unknown' });
  });

  it('personal best requires a real improvement over an earlier assessed attempt', async () => {
    const { versionId } = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    const first = sessionPayload({ learnerId, versionId, correct: 8, startedAt: '2026-10-10T01:00:00Z', localDay: '2026-10-10' });
    const same = sessionPayload({ learnerId, versionId, correct: 8, startedAt: '2026-10-11T01:00:00Z', localDay: '2026-10-11' });
    const better = sessionPayload({ learnerId, versionId, correct: 9, startedAt: '2026-10-12T01:00:00Z', localDay: '2026-10-12' });
    better.assessment.assessed_ms = 20_000; // 27 CWPM vs 16
    const codesFor = async (p: ReturnType<typeof sessionPayload>) =>
      (await as(db, guardianId, (tx) => rpc<{ awards: { badge_code: string; session_id: string }[] }>(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: p })))
        .awards.filter((a) => a.session_id === p.id).map((a) => a.badge_code);
    expect(await codesFor(first)).not.toContain('personal_best');
    expect(await codesFor(same)).not.toContain('personal_best');
    const codes = await codesFor(better);
    expect(codes).toContain('personal_best');
    expect(codes).toContain('three_days');
  });
});

describe('stories: ownership, versions and conflicts', () => {
  it('edits require the next revision; stale edits conflict', async () => {
    const { teacherId, storyId } = await setupTeacher(db);
    await as(db, teacherId, (tx) =>
      tx.query(`update public.stories set draft_title = 'Edited', revision = 2 where id = $1 and revision = 1`, [storyId]),
    );
    // A second editor still holding revision 1 updates zero rows (the client reports a conflict) ...
    const stale = await as(db, teacherId, (tx) =>
      tx.query(`update public.stories set draft_title = 'Stale', revision = 2 where id = $1 and revision = 1`, [storyId]),
    );
    expect(stale.affectedRows).toBe(0);
    // ... and skipping the check is rejected by the trigger.
    await expect(
      as(db, teacherId, (tx) => tx.query(`update public.stories set draft_title = 'Forced', revision = 9 where id = $1`, [storyId])),
    ).rejects.toThrow(/revision must advance/);
  });

  it('only owners or granted editors can edit a story', async () => {
    const { teacherId, storyId } = await setupTeacher(db);
    const otherTeacher = await createUser(db, { account_type: 'teacher' });
    const result = await as(db, otherTeacher, (tx) =>
      tx.query(`update public.stories set draft_title = 'Hijack', revision = revision + 1 where id = $1`, [storyId]),
    );
    expect(result.affectedRows).toBe(0);
    await expect(as(db, otherTeacher, (tx) => rpc(tx, 'publish_story', {
      p_story_id: storyId, p_expected_revision: 1, p_tokenizer_version: 1, p_word_count: 9,
    }))).rejects.toThrow(/cannot publish/);

    await as(db, teacherId, (tx) => rpc(tx, 'grant_story_editor', { p_story_id: storyId, p_user_id: otherTeacher }));
    const granted = await as(db, otherTeacher, (tx) =>
      tx.query(`update public.stories set draft_title = 'Shared edit', revision = revision + 1 where id = $1`, [storyId]),
    );
    expect(granted.affectedRows).toBe(1);
  });

  it('a guardian cannot create stories or put stories in the library', async () => {
    const guardian = await createUser(db);
    await expect(
      as(db, guardian, (tx) => tx.query(
        `insert into public.stories (owner_id, draft_title, draft_body, language, grade_level) values ($1, 'x', 'y', 'en', 1)`, [guardian])),
    ).rejects.toThrow(/row-level security/);
    const teacher = await createUser(db, { account_type: 'teacher' });
    await expect(
      as(db, teacher, (tx) => tx.query(
        `insert into public.stories (owner_id, visibility, draft_title, draft_body, language, grade_level) values ($1, 'library', 'x', 'y', 'en', 1)`, [teacher])),
    ).rejects.toThrow(/content editors/);
  });

  it('editing or archiving a story never changes the version an attempt used', async () => {
    const t = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    await enrollAndApprove(db, guardianId, learnerId, t.teacherId, t.classId, t.joinCode);
    const payload = sessionPayload({ learnerId, versionId: t.versionId });
    await as(db, guardianId, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: payload }));

    await as(db, t.teacherId, async (tx) => {
      await tx.query(`update public.stories set draft_body = 'Completely new text.', revision = 2 where id = $1`, [t.storyId]);
      const republished = await rpc<{ version_id: string; version_number: number }>(tx, 'publish_story', {
        p_story_id: t.storyId, p_expected_revision: 2, p_tokenizer_version: 1, p_word_count: 3,
      });
      expect(republished.version_number).toBe(2);
      await rpc(tx, 'archive_story', { p_story_id: t.storyId });
    });
    await expect(db.query(`update public.story_versions set body = 'x' where id = $1`, [t.versionId])).rejects.toThrow(/immutable/);

    // The guardian can still read the exact text their learner read.
    const version = await as(db, guardianId, (tx) =>
      tx.query<{ body: string }>('select v.body from public.reading_sessions s join public.story_versions v on v.id = s.story_version_id where s.id = $1', [payload.id]),
    );
    expect(version.rows[0].body).toBe('The cat sat on the mat. The dog ran.');
  });

  it('publishing the same content twice reuses the version', async () => {
    const { teacherId, storyId, versionId } = await setupTeacher(db);
    const again = await as(db, teacherId, (tx) => rpc<{ version_id: string }>(tx, 'publish_story', {
      p_story_id: storyId, p_expected_revision: 1, p_tokenizer_version: 1, p_word_count: 9,
    }));
    expect(again.version_id).toBe(versionId);
  });
});

describe('teacher corrections and feedback are audited', () => {
  it('records corrections append-only with an audit event', async () => {
    const t = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    await enrollAndApprove(db, guardianId, learnerId, t.teacherId, t.classId, t.joinCode);
    const payload = sessionPayload({ learnerId, versionId: t.versionId, correct: 7 });
    await as(db, guardianId, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: payload }));

    await as(db, t.teacherId, async (tx) => {
      await rpc(tx, 'add_assessment_correction', { p_session_id: payload.id, p_word_index: 8, p_corrected_status: 'correct', p_reason: 'Heard clearly on the recording' });
      await tx.query(`insert into public.teacher_feedback (session_id, learner_id, author_id, body) values ($1, $2, $3, 'Great reading!')`, [payload.id, learnerId, t.teacherId]);
      await rpc(tx, 'mark_session_reviewed', { p_session_id: payload.id, p_note: 'ok' });
      const corrections = await tx.query<{ previous_status: string }>('select previous_status from public.assessment_corrections where session_id = $1', [payload.id]);
      expect(corrections.rows[0].previous_status).toBe('substituted');
      expect(await count(tx, `select * from public.audit_events where entity_type in ('assessment_corrections','teacher_feedback','session_reviews') and actor_id = $1`, [t.teacherId])).toBe(3);
    });
    await expect(
      as(db, t.teacherId, (tx) => tx.query('delete from public.assessment_corrections where session_id = $1', [payload.id])),
    ).rejects.toThrow(/permission denied/);
    // The guardian sees the feedback but cannot write corrections.
    await as(db, guardianId, async (tx) => {
      expect(await count(tx, 'select * from public.teacher_feedback where learner_id = $1', [learnerId])).toBe(1);
    });
    await expect(as(db, guardianId, (tx) => rpc(tx, 'add_assessment_correction', {
      p_session_id: payload.id, p_word_index: 0, p_corrected_status: 'correct', p_reason: '',
    }))).rejects.toThrow(/only a teacher/);
  });
});

describe('teacher review queue', () => {
  it('lists only uncertain attempts of the teacher\'s own learners until reviewed', async () => {
    const t = await setupTeacher(db);
    const other = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    await enrollAndApprove(db, guardianId, learnerId, t.teacherId, t.classId, t.joinCode);
    const uncertain = sessionPayload({ learnerId, versionId: t.versionId });
    uncertain.assessment.status = 'needs_review';
    const fine = sessionPayload({ learnerId, versionId: t.versionId });
    for (const p of [uncertain, fine]) {
      await as(db, guardianId, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: p }));
    }
    const queue = await as(db, t.teacherId, (tx) => tx.query<{ session_id: string }>('select session_id from public.review_queue()'));
    expect(queue.rows.map((r) => r.session_id)).toEqual([uncertain.id]);
    expect(await as(db, other.teacherId, (tx) => count(tx, 'select * from public.review_queue()'))).toBe(0);
    await as(db, t.teacherId, (tx) => rpc(tx, 'mark_session_reviewed', { p_session_id: uncertain.id, p_note: '' }));
    expect(await as(db, t.teacherId, (tx) => count(tx, 'select * from public.review_queue()'))).toBe(0);
  });
});

describe('My Words synchronization', () => {
  it('saves are idempotent and tombstones win over older saves', async () => {
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    const save = (opId: string, savedAt: string) => as(db, guardianId, (tx) => rpc(tx, 'save_learner_word', {
      p_op_id: opId, p_learner_id: learnerId, p_language: 'en', p_word: 'Puddle', p_normalized: 'puddle',
      p_vocabulary_entry_id: null, p_story_version_id: null, p_saved_at: savedAt,
    }));
    const op = uuid();
    await save(op, '2026-10-15T01:00:00Z');
    await save(op, '2026-10-15T01:00:00Z');
    await as(db, guardianId, (tx) => rpc(tx, 'archive_learner_word', {
      p_op_id: uuid(), p_learner_id: learnerId, p_language: 'en', p_normalized: 'puddle', p_archived_at: '2026-10-15T02:00:00Z',
    }));
    // A delayed save from before the removal does not resurrect the word.
    await save(uuid(), '2026-10-15T01:30:00Z');
    let rows = await as(db, guardianId, (tx) => tx.query<{ archived_at: string | null }>('select archived_at from public.learner_vocabulary where learner_id = $1', [learnerId]));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].archived_at).not.toBeNull();
    // A newer save does.
    await save(uuid(), '2026-10-15T03:00:00Z');
    rows = await as(db, guardianId, (tx) => tx.query('select archived_at from public.learner_vocabulary where learner_id = $1', [learnerId]));
    expect(rows.rows[0]).toEqual({ archived_at: null });
  });
});

describe('private audio storage', () => {
  async function submitWithAudio(guardianId: string, learnerId: string, versionId: string) {
    const payload = sessionPayload({ learnerId, versionId, audio: 'pending' });
    const result = await as(db, guardianId, (tx) =>
      rpc<{ audio_status: string }>(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: payload }),
    );
    return { payload, result };
  }
  const insertObject = (tx: { query: PGlite['query'] }, name: string) =>
    tx.query(`insert into storage.objects (bucket_id, name, metadata) values ('reading-audio', $1, '{"size": 1000, "mimetype": "audio/webm"}')`, [name]);

  it('recordings are not uploaded without a recording policy', async () => {
    const { versionId } = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    const { payload, result } = await submitWithAudio(guardianId, learnerId, versionId);
    expect(result.audio_status).toBe('local_only');
    await expect(as(db, guardianId, (tx) => insertObject(tx, `${learnerId}/${payload.id}.webm`))).rejects.toThrow(/row-level security/);
  });

  it('with consent the guardian can upload to the exact session path only', async () => {
    const t = await setupTeacher(db);
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    await as(db, guardianId, (tx) => rpc(tx, 'set_learner_audio_consent', { p_learner_id: learnerId, p_consent: true }));
    const { payload, result } = await submitWithAudio(guardianId, learnerId, t.versionId);
    expect(result.audio_status).toBe('pending');
    const path = `${learnerId}/${payload.id}.webm`;

    // Confirming before the object exists is refused: no false "uploaded".
    await expect(as(db, guardianId, (tx) => rpc(tx, 'confirm_audio_upload', { p_op_id: uuid(), p_session_id: payload.id, p_path: path })))
      .rejects.toThrow(/not found in storage/);

    await expect(as(db, guardianId, (tx) => insertObject(tx, `${learnerId}/${uuid()}.webm`))).rejects.toThrow(/row-level security/);
    await expect(as(db, guardianId, (tx) => insertObject(tx, `${learnerId}/nested/${payload.id}.webm`))).rejects.toThrow(/row-level security/);
    await as(db, guardianId, (tx) => insertObject(tx, path));
    const confirmed = await as(db, guardianId, (tx) => rpc<{ uploaded: boolean }>(tx, 'confirm_audio_upload', { p_op_id: uuid(), p_session_id: payload.id, p_path: path }));
    expect(confirmed.uploaded).toBe(true);

    // Strangers and unrelated teachers cannot read it; the class teacher can after approval.
    const stranger = await createUser(db);
    expect(await as(db, stranger, (tx) => count(tx, `select * from storage.objects where name = $1`, [path]))).toBe(0);
    expect(await as(db, t.teacherId, (tx) => count(tx, `select * from storage.objects where name = $1`, [path]))).toBe(0);
    await enrollAndApprove(db, guardianId, learnerId, t.teacherId, t.classId, t.joinCode);
    expect(await as(db, t.teacherId, (tx) => count(tx, `select * from storage.objects where name = $1`, [path]))).toBe(1);

    // Recordings cannot be overwritten.
    const updated = await as(db, guardianId, (tx) => tx.query(`update storage.objects set metadata = '{}' where name = $1`, [path]));
    expect(updated.affectedRows).toBe(0);
  });

  it('a class recording policy lets class staff upload for roster learners', async () => {
    const t = await setupTeacher(db);
    const learnerId = uuid();
    await as(db, t.teacherId, async (tx) => {
      await rpc(tx, 'teacher_add_learner', { p_class_id: t.classId, p_learner_id: learnerId, p_display_name: 'Roster kid', p_avatar: 'frog' });
      await rpc(tx, 'set_class_recording_policy', { p_class_id: t.classId, p_audio_upload_enabled: true, p_retention_days: 14 });
    });
    const payload = sessionPayload({ learnerId, versionId: t.versionId, audio: 'pending' });
    await as(db, t.teacherId, (tx) => rpc(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: payload }));
    const path = `${learnerId}/${payload.id}.webm`;
    await as(db, t.teacherId, (tx) => insertObject(tx, path));
    await as(db, t.teacherId, (tx) => rpc(tx, 'confirm_audio_upload', { p_op_id: uuid(), p_session_id: payload.id, p_path: path }));
    const row = await as(db, t.teacherId, (tx) => tx.query<{ days: number }>(
      `select extract(day from (audio_expires_at - audio_uploaded_at))::int as days from public.reading_sessions where id = $1`, [payload.id]));
    expect(row.rows[0].days).toBe(14);
  });
});
