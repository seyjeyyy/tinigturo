import { afterEach, describe, expect, it, vi } from 'vitest';
import { deletePartition, getDb } from '../db/localDb';
import { ensureBundledContent } from './bootstrap';
import { createLearner, listLearners } from './learners';
import { listLearnerWords, lookupVocabulary, removeWord, saveWord } from './words';
import { removeStoryDownload, saveDownloadedStory } from './stories';
import { finalizeSession, startSession } from './sessions';
import { unassessedSummary } from '../assessment/scoring';
import { StorageFullError } from '../db/errors';
import { STARTER_STORIES } from '../content/starterStories';

const A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as const;
const B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as const;

afterEach(async () => {
  await Promise.all([deletePartition(A), deletePartition(B), deletePartition('device')]);
});

describe('identity partitions', () => {
  it('keeps each account\'s learners and work separate, and deletes only one', async () => {
    const dbA = getDb(A);
    const dbB = getDb(B);
    const ana = await createLearner(dbA, { displayName: 'Ana', avatar: 'owl', gradeLevel: 1 });
    await createLearner(dbB, { displayName: 'Ben', avatar: 'fox', gradeLevel: 2 });
    expect((await listLearners(dbA)).map((l) => l.displayName)).toEqual(['Ana']);
    expect((await listLearners(dbB)).map((l) => l.displayName)).toEqual(['Ben']);
    expect(await dbB.learners.get(ana.id)).toBeUndefined();

    await deletePartition(A);
    expect((await listLearners(getDb(A)))).toEqual([]);
    expect((await listLearners(getDb(B))).map((l) => l.displayName)).toEqual(['Ben']);
  });

  it('device-only learners never queue sync operations', async () => {
    const db = getDb('device');
    await createLearner(db, { displayName: 'Cara', avatar: 'cat', gradeLevel: null });
    expect(await db.outbox.count()).toBe(0);
    const account = getDb(A);
    await createLearner(account, { displayName: 'Dan', avatar: 'cat', gradeLevel: null });
    expect(await account.outbox.count()).toBe(1);
  });
});

describe('learners on a shared device', () => {
  it('keeps saved words separate per learner', async () => {
    const db = getDb('device');
    const a = await createLearner(db, { displayName: 'Ana', avatar: 'owl', gradeLevel: 1 });
    const b = await createLearner(db, { displayName: 'Ben', avatar: 'fox', gradeLevel: 1 });
    await saveWord(db, { learnerId: a.id, language: 'en', word: 'Puddle', vocabularyEntryId: null, storyVersionId: null });
    expect(await listLearnerWords(db, a.id)).toHaveLength(1);
    expect(await listLearnerWords(db, b.id)).toHaveLength(0);
  });
});

describe('My Words', () => {
  it('saves once, removes with a tombstone, and can save again', async () => {
    const db = getDb(A);
    const learner = await createLearner(db, { displayName: 'Ana', avatar: 'owl', gradeLevel: 1 });
    const { word } = await saveWord(db, { learnerId: learner.id, language: 'en', word: 'puddles', vocabularyEntryId: null, storyVersionId: null });
    await saveWord(db, { learnerId: learner.id, language: 'en', word: 'puddles', vocabularyEntryId: null, storyVersionId: null });
    expect(await db.outbox.where('type').equals('word.save').count()).toBe(1);
    await removeWord(db, word.id);
    expect(await listLearnerWords(db, learner.id)).toHaveLength(0);
    expect((await db.learnerWords.get(word.id))?.archivedAt).not.toBeNull();
    await saveWord(db, { learnerId: learner.id, language: 'en', word: 'puddles', vocabularyEntryId: null, storyVersionId: null });
    expect(await listLearnerWords(db, learner.id)).toHaveLength(1);
  });

  it('looks up starter vocabulary with simple inflections', async () => {
    const db = getDb('device');
    await ensureBundledContent(db);
    expect((await lookupVocabulary(db, 'en', 'Puddles'))?.headword).toBe('puddle');
    expect((await lookupVocabulary(db, 'en', 'weeds'))?.headword).toBe('weeds');
    expect(await lookupVocabulary(db, 'en', 'zyzzyva')).toBeNull();
  });
});

describe('downloads and storage', () => {
  const story = { ...STARTER_STORIES[0], id: '99999999-9999-4999-8999-999999999999', storyId: '99999999-9999-4999-8999-999999999990', title: 'Downloaded' };

  it('removing a download keeps readings and unsynced work', async () => {
    const db = getDb(A);
    const learner = await createLearner(db, { displayName: 'Ana', avatar: 'owl', gradeLevel: 1 });
    await saveDownloadedStory(db, story);
    const session = await startSession(db, { learnerId: learner.id, story: { ...story, source: 'downloaded', downloadedAt: null, sizeBytes: 1 }, assignmentId: null, mode: 'read_aloud', recognition: { plan: 'none', engine: null, reason: 'recognition_unavailable' } });
    expect((await removeStoryDownload(db, story.id)).removed).toBe(false); // in progress
    await finalizeSession(db, { sessionId: session.id, timing: { activeMs: 1, pausedMs: 0, interruptedMs: 0, assessedMs: 0 }, transcript: null, assessment: unassessedSummary(10, { activeMs: 1, pausedMs: 0, interruptedMs: 0, assessedMs: 0 }, 'recognition_unavailable'), wordResults: null, shareAudio: false });
    const before = await db.outbox.count();
    expect((await removeStoryDownload(db, story.id)).removed).toBe(true);
    expect(await db.sessions.get(session.id)).toBeDefined();
    expect(await db.outbox.count()).toBe(before);
    expect((await removeStoryDownload(db, STARTER_STORIES[0].id)).removed).toBe(false);
  });

  it('reports a full device as StorageFullError', async () => {
    const db = getDb('device');
    const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    const spy = vi.spyOn(db.stories, 'put').mockRejectedValueOnce(quota);
    await expect(saveDownloadedStory(db, story)).rejects.toBeInstanceOf(StorageFullError);
    spy.mockRestore();
    expect(await db.stories.get(story.id)).toBeUndefined();
    expect(await db.downloads.get(`story:${story.id}`)).toBeUndefined();
  });

  it('rejects invalid content from the server', async () => {
    const db = getDb('device');
    await expect(saveDownloadedStory(db, { ...story, body: '' })).rejects.toThrow(/empty/);
    await expect(saveDownloadedStory(db, { ...story, gradeLevel: 42 })).rejects.toThrow(/grade/);
  });
});
