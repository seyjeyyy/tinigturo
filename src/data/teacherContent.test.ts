import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deletePartition, getDb, type TinigDb } from '../db/localDb';
import { ensureBundledContent } from './bootstrap';
import { lookupVocabulary } from './words';
import { narrationKey, removeNarration, saveNarration, savePublishedVocabulary } from './teacherContent';
import { checkNarrationFile, parseNarrationTimings } from '../narration/narrationFiles';
import { AudioNarrator } from '../narration/narrator';
import { STARTER_STORIES } from '../content/starterStories';
import { tokenizePassage } from '../text/tokenize';
import { toCriteria, gradebookCsvRow, GRADEBOOK_CSV_HEADER } from '../features/teacher/Grading';
import type { NarrationRow, VocabularyRow } from '../backend/teacherToolsApi';

const PARTITION = 'user:44444444-4444-4444-8444-444444444444' as const;
let db: TinigDb;
beforeEach(async () => {
  db = getDb(PARTITION);
  await ensureBundledContent(db);
});
afterEach(() => deletePartition(PARTITION));

function vocab(overrides: Partial<VocabularyRow>): VocabularyRow {
  return {
    id: crypto.randomUUID(), language: 'en', headword: 'puddle', normalized: 'puddle', part_of_speech: 'noun',
    definition: 'Reviewed: a small pool of water.', example: null, syllables: 'pud·dle', syllables_verified: true,
    review_status: 'published', version: 3, reviewed_at: null, published_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z',
    ...overrides,
  };
}

describe('reviewed vocabulary on the device', () => {
  it('a published entry replaces the bundled draft for the same word and works offline', async () => {
    expect((await lookupVocabulary(db, 'en', 'puddle'))?.reviewStatus).toBe('draft');
    const count = await savePublishedVocabulary(db, [vocab({}), vocab({ headword: 'secret', normalized: 'secret', review_status: 'draft' as never })]);
    expect(count).toBe(1); // drafts never reach devices
    const entry = await lookupVocabulary(db, 'en', 'puddles');
    expect(entry).toMatchObject({ reviewStatus: 'published', definition: 'Reviewed: a small pool of water.', syllablesVerified: true });
    expect(await db.vocabulary.where('[language+normalized]').equals(['en', 'puddle']).count()).toBe(1);
    expect(await lookupVocabulary(db, 'en', 'secret')).toBeNull();
  });

  it('never replaces a newer downloaded version with an older one', async () => {
    const id = crypto.randomUUID();
    await savePublishedVocabulary(db, [vocab({ id, version: 5, definition: 'Newer' })]);
    await savePublishedVocabulary(db, [vocab({ id, version: 4, definition: 'Older' })]);
    expect((await db.vocabulary.get(id))?.definition).toBe('Newer');
  });
});

describe('narration recordings', () => {
  const story = STARTER_STORIES[2];
  const row = (overrides: Partial<NarrationRow> = {}): NarrationRow => ({
    id: crypto.randomUUID(), story_version_id: story.id, story_id: story.storyId, audio_path: `${story.storyId}/narration/${story.id}/a.mp3`,
    mime_type: 'audio/mpeg', size_bytes: 5, duration_ms: 4000, timings: [{ w: 0, s: 0, e: 300 }], note: '', status: 'active', created_at: '', ...overrides,
  });

  it('are stored with their exact story version and timings, and can be removed', async () => {
    await saveNarration(db, (await db.stories.get(story.id))!, row(), new Blob(['audio']));
    expect((await db.stories.get(story.id))?.narration).toEqual({ audioPath: row().audio_path, timings: [{ wordIndex: 0, startMs: 0, endMs: 300 }] });
    expect(await db.recordings.get(narrationKey(story.id))).toBeDefined();
    await removeNarration(db, story.id);
    expect((await db.stories.get(story.id))?.narration).toBeNull();
    expect(await db.recordings.get(narrationKey(story.id))).toBeUndefined();
  });

  it('refuse a recording made for a different version', async () => {
    await expect(saveNarration(db, (await db.stories.get(story.id))!, row({ story_version_id: crypto.randomUUID() }), new Blob(['a']))).rejects.toThrow(/different version/);
  });

  it('play without highlighting when no word timings were supplied', () => {
    const passage = tokenizePassage(story.body, story.language);
    expect(new AudioNarrator(passage, 'blob:none', []).getState().granularity).toBe('unknown');
    expect(new AudioNarrator(passage, 'blob:none', [{ wordIndex: 0, startMs: 0, endMs: 200 }]).getState().granularity).toBe('word');
  });

  it('accept only supported, small audio files', () => {
    expect(checkNarrationFile({ type: 'audio/mpeg', size: 1000 })).toMatchObject({ ok: true, extension: 'mp3' });
    expect(checkNarrationFile({ type: 'audio/x-m4a', size: 1000 })).toMatchObject({ ok: true, mimeType: 'audio/mp4' });
    expect(checkNarrationFile({ type: 'audio/wav', size: 1000 }).ok).toBe(false);
    expect(checkNarrationFile({ type: 'audio/mpeg', size: 11 * 1024 * 1024 }).ok).toBe(false);
  });

  it('check timings files against the version’s words and the recording length', () => {
    expect(parseNarrationTimings('[{"w":0,"s":0,"e":300},{"wordIndex":1,"startMs":300,"endMs":650}]', 10, 4000)).toEqual({
      ok: true, timings: [{ w: 0, s: 0, e: 300 }, { w: 1, s: 300, e: 650 }],
    });
    expect(parseNarrationTimings('not json', 10, null).ok).toBe(false);
    expect(parseNarrationTimings('[{"w":3,"s":0,"e":100},{"w":2,"s":100,"e":200}]', 10, null)).toMatchObject({ ok: false, error: /reading order/ });
    expect(parseNarrationTimings('[{"w":12,"s":0,"e":100}]', 10, null)).toMatchObject({ ok: false, error: /not in this story version/ });
    expect(parseNarrationTimings('[{"w":0,"s":0,"e":9000}]', 10, 4000)).toMatchObject({ ok: false, error: /ends after the recording/ });
    expect(parseNarrationTimings('[{"w":0,"s":500,"e":400}]', 10, null)).toMatchObject({ ok: false, error: /end after it starts/ });
  });
});

describe('teacher grading helpers', () => {
  it('builds unique criterion keys and numbered levels from what the teacher typed', () => {
    const criteria = toCriteria([
      { label: 'Expression', levels: 'Low, Middle, High' },
      { label: 'Expression!', levels: 'A, B' },
      { label: '   ', levels: 'ignored' },
    ]);
    expect(criteria.map((c) => c.key)).toEqual(['expression', 'expression_2']);
    expect(criteria[0].levels).toEqual([{ value: 1, label: 'Low' }, { value: 2, label: 'Middle' }, { value: 3, label: 'High' }]);
  });

  it('exports unassessed readings without word-check numbers', () => {
    const row = gradebookCsvRow({
      session_id: 's', learner_id: 'l', learner_name: 'Ana', story_title: 'The Red Kite', started_at: '2026-10-16T01:00:00Z',
      assessment_status: 'unassessed', completion: 'unknown', coverage: 0, cwpm: null, grade_id: 'g', grade_status: 'published',
      final_level: 'On track', criterion_levels: { accuracy: 2 }, feedback: 'Well read', rubric_id: 'r', rubric_name: 'Oral reading',
      rubric_version: 1, graded_at: '2026-10-16T02:00:00Z', published_at: '2026-10-16T02:00:00Z', revision: 1,
    });
    const at = (column: string) => row[GRADEBOOK_CSV_HEADER.indexOf(column)];
    expect(at('Coverage')).toBeNull();
    expect(at('Completion')).toBeNull();
    expect(at('Final grade')).toBe('On track');
  });
});
