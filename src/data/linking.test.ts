import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deletePartition, getDb, kvGet, kvSet, type TinigDb } from '../db/localDb';
import { metaDelete } from '../db/metaDb';
import { ensureBundledContent } from './bootstrap';
import { createLearner } from './learners';
import { finalizeSession, startSession } from './sessions';
import { recordPractice, saveWord } from './words';
import { linkDeviceLearners, listLinkCandidates, pendingLinkJournal, resumeLinking } from './linking';
import { STARTER_STORIES } from '../content/starterStories';
import { unassessedSummary } from '../assessment/scoring';
import { FakeRemote } from '../test/fakeRemote';
import { SyncEngine } from '../sync/engine';

const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const story = STARTER_STORIES[2];
let device: TinigDb;
let account: TinigDb;

async function saveReading(db: TinigDb, learnerId: string, audio = true) {
  const session = await startSession(db, {
    learnerId, story, assignmentId: null, mode: 'read_aloud', recognition: { plan: 'none', engine: null, reason: 'recognition_unavailable' },
  });
  const timing = { activeMs: 30_000, pausedMs: 0, interruptedMs: 0, assessedMs: 0 };
  return finalizeSession(db, {
    sessionId: session.id, timing, transcript: null, assessment: unassessedSummary(80, timing, 'recognition_unavailable'), wordResults: null,
    recording: audio ? { blob: new Blob(['audio'], { type: 'audio/webm' }), mimeType: 'audio/webm' } : null, shareAudio: false,
  });
}

beforeEach(async () => {
  device = getDb('device');
  account = getDb(`user:${USER}`);
  await ensureBundledContent(device);
  await ensureBundledContent(account);
});

afterEach(async () => {
  await metaDelete('linkJournal');
  await Promise.all([deletePartition('device'), deletePartition(`user:${USER}`), deletePartition(`user:${OTHER}`)]);
});

describe('linking device-only readers into an account', () => {
  it('moves the chosen reader with readings, recordings, words, practice and badges, keeping every ID', async () => {
    const ana = await createLearner(device, { displayName: 'Ana', avatar: 'owl', gradeLevel: 3 });
    const ben = await createLearner(device, { displayName: 'Ben', avatar: 'fox', gradeLevel: 2 });
    const { session } = await saveReading(device, ana.id);
    const unfinished = await startSession(device, {
      learnerId: ana.id, story, assignmentId: null, mode: 'read_aloud', recognition: { plan: 'none', engine: null, reason: 'recognition_unavailable' },
    });
    await device.audioChunks.put({ sessionId: unfinished.id, seq: 0, blob: new Blob(['chunk']), mimeType: 'audio/webm' });
    const { word } = await saveWord(device, { learnerId: ana.id, language: 'en', word: 'kite', vocabularyEntryId: null, storyVersionId: story.id });
    await recordPractice(device, word.id);
    await recordPractice(device, word.id);
    await kvSet(device, 'activeLearnerId', ana.id);

    const candidates = await listLinkCandidates(device);
    expect(candidates.find((c) => c.learner.id === ana.id)).toMatchObject({ savedReadings: 1, unfinishedReadings: 1, recordings: 1, words: 1 });
    expect(await device.outbox.count()).toBe(0); // device-only work never queued anything

    const report = await linkDeviceLearners({ source: device, target: account, userId: USER, email: 'parent@example.org', learnerIds: [ana.id] });
    expect(report.linked).toEqual([ana.id]);

    // In the account, with the same IDs, ready to sync.
    expect(await account.learners.get(ana.id)).toMatchObject({ origin: 'account', cloud: 'pending', displayName: 'Ana' });
    expect(await account.sessions.get(session.id)).toMatchObject({ status: 'saved', sync: 'pending' });
    expect(await account.sessions.get(unfinished.id)).toMatchObject({ status: 'in_progress' });
    expect(await account.recordings.get(session.id)).toBeDefined();
    expect(await account.audioChunks.where('sessionId').equals(unfinished.id).count()).toBe(1);
    expect(await account.learnerWords.get(word.id)).toMatchObject({ practiceCount: 2, sync: 'pending' });
    expect((await account.rewards.where('learnerId').equals(ana.id).toArray()).every((r) => r.status === 'pending')).toBe(true);
    const ops = await account.outbox.toArray();
    const create = ops.find((o) => o.type === 'learner.create')!;
    expect(ops.filter((o) => o.type === 'session.submit').map((o) => o.entityId)).toEqual([session.id]);
    expect(ops.filter((o) => o.type === 'session.submit' || o.type === 'word.save').every((o) => o.dependsOn.includes(create.opId))).toBe(true);
    expect(ops.filter((o) => o.type === 'word.practice')).toHaveLength(2);
    expect(ops.some((o) => o.type === 'audio.upload')).toBe(false); // recordings are not uploaded by linking

    // Gone from the device partition; the other reader is untouched.
    expect(await device.learners.get(ana.id)).toBeUndefined();
    expect(await device.sessions.where('learnerId').equals(ana.id).count()).toBe(0);
    expect(await device.recordings.get(session.id)).toBeUndefined();
    expect(await kvGet(device, 'activeLearnerId')).toBeNull();
    expect(await device.learners.get(ben.id)).toBeDefined();
    expect(await pendingLinkJournal(USER)).toBeNull();
  });

  it('finishes an interrupted link without copying anything twice', async () => {
    const ana = await createLearner(device, { displayName: 'Ana', avatar: 'owl', gradeLevel: 3 });
    await saveReading(device, ana.id);
    const crash = vi.spyOn(device.learners, 'delete').mockRejectedValueOnce(new Error('tab closed'));
    await expect(linkDeviceLearners({ source: device, target: account, userId: USER, email: null, learnerIds: [ana.id] })).rejects.toThrow();
    crash.mockRestore();
    // The copy committed; the device copy was not removed yet.
    expect(await account.learners.get(ana.id)).toBeDefined();
    expect(await device.learners.get(ana.id)).toBeDefined();
    expect(await pendingLinkJournal(USER)).not.toBeNull();
    const opsBefore = await account.outbox.count();

    const report = await resumeLinking({ source: device, target: account, userId: USER });
    expect(report?.alreadyLinked).toEqual([ana.id]);
    expect(await account.outbox.count()).toBe(opsBefore);
    expect(await account.sessions.where('learnerId').equals(ana.id).count()).toBe(1);
    expect(await device.learners.get(ana.id)).toBeUndefined();
    expect(await pendingLinkJournal(USER)).toBeNull();
  });

  it('only links from this device into the signed-in account, and never over another account’s unfinished link', async () => {
    const ana = await createLearner(device, { displayName: 'Ana', avatar: 'owl', gradeLevel: 3 });
    await expect(linkDeviceLearners({ source: device, target: getDb(`user:${OTHER}`), userId: USER, email: null, learnerIds: [ana.id] })).rejects.toThrow(/signed-in account/);
    await expect(linkDeviceLearners({ source: account, target: account, userId: USER, email: null, learnerIds: [ana.id] })).rejects.toThrow(/saved on this device/);

    const crash = vi.spyOn(device.learners, 'delete').mockRejectedValueOnce(new Error('tab closed'));
    await expect(linkDeviceLearners({ source: device, target: getDb(`user:${OTHER}`), userId: OTHER, email: null, learnerIds: [ana.id] })).rejects.toThrow();
    crash.mockRestore();
    await expect(linkDeviceLearners({ source: device, target: account, userId: USER, email: null, learnerIds: [ana.id] })).rejects.toThrow(/Another account/);
    expect(await resumeLinking({ source: device, target: account, userId: USER })).toBeNull();
  });

  it('syncs once: retries create no duplicates, and a learner ID owned by someone else is refused and kept', async () => {
    const ana = await createLearner(device, { displayName: 'Ana', avatar: 'owl', gradeLevel: 3 });
    const cara = await createLearner(device, { displayName: 'Cara', avatar: 'cat', gradeLevel: 4 });
    const { session } = await saveReading(device, ana.id);
    const { session: caraSession } = await saveReading(device, cara.id);
    const { word } = await saveWord(device, { learnerId: ana.id, language: 'en', word: 'kite', vocabularyEntryId: null, storyVersionId: story.id });
    await recordPractice(device, word.id);
    await linkDeviceLearners({ source: device, target: account, userId: USER, email: null, learnerIds: [ana.id, cara.id] });

    const remote = new FakeRemote(USER);
    remote.foreignLearnerIds.add(cara.id);
    remote.dropResponses = 1; // the first acknowledgement is lost
    const engine = new SyncEngine({ db: account, remote, expectedUserId: USER, isOnline: () => true, shouldUploadAudio: () => false, random: () => 1 });
    await engine.sync({ manual: true });
    await engine.sync({ manual: true });
    await engine.sync({ manual: true });

    expect(remote.learnerIds.has(ana.id)).toBe(true);
    expect([...remote.sessions.keys()]).toEqual([session.id]);
    expect(remote.words.get(`${ana.id}|kite`)?.practiceCount).toBe(1);
    expect(await account.sessions.get(session.id)).toMatchObject({ sync: 'synced' });

    // Refused by the server: kept on this device, clearly not synced, nothing attached.
    expect(remote.learnerIds.has(cara.id)).toBe(false);
    expect(remote.sessions.has(caraSession.id)).toBe(false);
    const caraCreate = (await account.outbox.toArray()).find((o) => o.type === 'learner.create' && o.entityId === cara.id);
    expect(caraCreate?.status).toBe('failed');
    expect(await account.sessions.get(caraSession.id)).toBeDefined();
  });
});
