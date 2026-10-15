import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { as, createDatabase, rpc, uuid } from './harness';
import { setupGuardianWithLearner } from './fixtures';
import { STARTER_STORIES } from '../../src/content/starterStories';
import { tokenizePassage } from '../../src/text/tokenize';
import { StreamingAligner } from '../../src/alignment/aligner';
import { assessAttempt } from '../../src/assessment/scoring';
import { buildSessionPayload } from '../../src/sync/payload';
import type { ReadingSessionRecord } from '../../src/domain/types';

let db: PGlite;
const here = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  db = await createDatabase();
  await db.exec(readFileSync(join(here, '..', 'seed.sql'), 'utf8'));
});

describe('development seed', () => {
  it('contains the starter library with the same IDs and word counts as the app', async () => {
    const rows = await db.query<{ id: string; word_count: number }>('select id, word_count from public.story_versions order by id');
    expect(rows.rows.map((r) => r.id)).toEqual(STARTER_STORIES.map((s) => s.id).sort());
    for (const story of STARTER_STORIES) {
      const row = rows.rows.find((r) => r.id === story.id)!;
      expect(row.word_count).toBe(tokenizePassage(story.body, story.language).words.length);
    }
  });

  it('contains no learner activity', async () => {
    for (const table of ['learners', 'reading_sessions', 'session_assessments', 'badge_awards', 'learner_vocabulary', 'classes']) {
      const r = await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
      expect(r.rows[0].n).toBe(0);
    }
  });

  it('accepts a real client-built attempt on a seeded story end to end', async () => {
    const { guardianId, learnerId } = await setupGuardianWithLearner(db);
    const story = STARTER_STORIES[1];
    const passage = tokenizePassage(story.body, story.language);
    const aligner = new StreamingAligner(passage.words, story.language);
    aligner.update('a', story.body, true, 50_000);
    const timing = { activeMs: 55_000, pausedMs: 2_000, interruptedMs: 0, assessedMs: 55_000 };
    const engine = { id: 'web-speech-on-device', version: 'chrome-141', processing: 'on_device' as const };
    const { summary, words } = assessAttempt({ result: aligner.finish(), timing, method: 'transcript_alignment_live', engine });
    const session: ReadingSessionRecord = {
      id: uuid(), learnerId, storyId: story.storyId, storyVersionId: story.id, assignmentId: null, mode: 'read_aloud', status: 'saved',
      startedAt: '2026-10-15T01:00:00.000Z', endedAt: '2026-10-15T01:01:00.000Z', localDay: '2026-10-15', timing,
      recognition: { plan: 'on_device', engine, reason: null }, transcript: aligner.log(), assessment: summary, wordResults: words,
      audio: { status: 'none', mimeType: null, sizeBytes: null, remotePath: null, error: null }, reviewRequested: false, recovered: false,
      sync: 'pending', updatedAt: '2026-10-15T01:01:00.000Z',
    };
    const result = await as(db, guardianId, (tx) =>
      rpc<{ awards: { badge_code: string }[] }>(tx, 'submit_reading_session', { p_op_id: uuid(), p_session: buildSessionPayload(session, false) }),
    );
    expect(result.awards.map((a) => a.badge_code)).toContain('story_finisher');
    const stored = await as(db, guardianId, (tx) => tx.query<{ cwpm: string; correct_words: number }>('select cwpm, correct_words from public.session_assessments where session_id = $1', [session.id]));
    expect(stored.rows[0].correct_words).toBe(passage.words.length);
    expect(Number(stored.rows[0].cwpm)).toBe(summary.cwpm);
  });

  it('library stories are readable by any signed-in user but not anonymously', async () => {
    const { guardianId } = await setupGuardianWithLearner(db);
    const visible = await as(db, guardianId, (tx) => tx.query('select id from public.story_versions'));
    expect(visible.rows).toHaveLength(STARTER_STORIES.length);
    await expect(as(db, null, (tx) => tx.query('select id from public.story_versions'))).rejects.toThrow(/permission denied/);
  });
});
