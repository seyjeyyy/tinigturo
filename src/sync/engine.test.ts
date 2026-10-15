import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deletePartition, getDb, type TinigDb } from '../db/localDb';
import { ensureBundledContent } from '../data/bootstrap';
import { createLearner } from '../data/learners';
import { finalizeSession, requestTeacherReview, startSession } from '../data/sessions';
import { saveWord, removeWord } from '../data/words';
import { STARTER_STORIES } from '../content/starterStories';
import { assessAttempt } from '../assessment/scoring';
import { StreamingAligner } from '../alignment/aligner';
import { tokenizePassage } from '../text/tokenize';
import { FakeRemote } from '../test/fakeRemote';
import { SyncEngine, resolveStoryConflict } from './engine';
import { newOp } from './outbox';
import { RemoteError } from '../backend/errors';

const USER = '11111111-1111-4111-8111-111111111111';
const story = STARTER_STORIES[0];
let db: TinigDb;
let remote: FakeRemote;
let clock: number;

function engine(overrides: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) {
  return new SyncEngine({
    db, remote, expectedUserId: USER, isOnline: () => !remote.offline, now: () => clock, random: () => 1,
    shouldUploadAudio: () => true, ...overrides,
  });
}

async function readAttempt(learnerId: string, opts: { audio?: boolean } = {}) {
  const session = await startSession(db, {
    learnerId, story, assignmentId: null, mode: 'read_aloud',
    recognition: { plan: 'on_device', engine: { id: 'test', version: '1', processing: 'on_device' }, reason: null },
  });
  const passage = tokenizePassage(story.body, story.language);
  const aligner = new StreamingAligner(passage.words, story.language);
  aligner.update('a', story.body, true, 30_000);
  const timing = { activeMs: 40_000, pausedMs: 0, interruptedMs: 0, assessedMs: 40_000 };
  const { summary, words } = assessAttempt({ result: aligner.finish(), timing, method: 'transcript_alignment_live', engine: { id: 'test', version: '1', processing: 'on_device' } });
  return finalizeSession(db, {
    sessionId: session.id, timing, transcript: aligner.log(), assessment: summary, wordResults: words,
    recording: opts.audio ? { blob: new Blob(['audio-bytes'], { type: 'audio/webm' }), mimeType: 'audio/webm' } : null,
    shareAudio: opts.audio ?? false,
  });
}

beforeEach(async () => {
  clock = Date.parse('2026-10-15T08:00:00Z');
  db = getDb(`user:${USER}`);
  await ensureBundledContent(db);
  remote = new FakeRemote(USER);
});

afterEach(async () => {
  await deletePartition(`user:${USER}`);
});

describe('SyncEngine', () => {
  it('keeps everything locally while offline and syncs on reconnect', async () => {
    const learner = await createLearner(db, { displayName: 'Ana', avatar: 'owl', gradeLevel: 1 });
    const { session } = await readAttempt(learner.id);
    remote.offline = true;

    const offline = await engine().sync();
    expect(offline.phase).toBe('offline');
    expect(await db.outbox.where('status').equals('pending').count()).toBe(2);
    expect((await engine().state()).message).toMatch(/saved on this device/);

    remote.offline = false;
    const online = await engine().sync();
    expect(online).toMatchObject({ phase: 'idle', synced: 2 });
    expect(remote.sessions.has(session.id)).toBe(true);
    expect((await db.sessions.get(session.id))?.sync).toBe('synced');
    expect((await db.learners.get(learner.id))?.cloud).toBe('synced');
    const rewards = await db.rewards.where('learnerId').equals(learner.id).toArray();
    expect(rewards.find((r) => r.badgeCode === 'first_practice')?.status).toBe('validated');
    expect((await engine().state()).lastSuccessAt).toBe(new Date(clock).toISOString());
  });

  it('a lost acknowledgement is retried without duplicating sessions or rewards', async () => {
    const learner = await createLearner(db, { displayName: 'Ben', avatar: 'fox', gradeLevel: 2 });
    const { session } = await readAttempt(learner.id);
    await engine().sync(); // learner + session, both acknowledged
    const { session: second } = await readAttempt(learner.id);

    remote.dropResponses = 1; // the server applies the submit but the reply is lost
    const first = await engine().sync();
    expect(first.phase).toBe('offline');
    const op = await db.outbox.where('entityId').equals(second.id).first();
    expect(op?.status).toBe('pending');
    expect(op?.attempts).toBe(1);

    clock += 60_000;
    await engine().sync();
    expect(remote.sessions.size).toBe(2);
    expect([...remote.sessions.keys()].sort()).toEqual([session.id, second.id].sort());
    const firstPractice = [...remote.awards.keys()].filter((k) => k.includes('|first_practice|'));
    expect(firstPractice).toHaveLength(1);
    expect((await db.outbox.get(op!.opId))?.status).toBe('synced');
  });

  it('backs off exponentially after network failures', async () => {
    const learner = await createLearner(db, { displayName: 'Cara', avatar: 'cat', gradeLevel: 1 });
    remote.dropResponses = 1;
    await engine().sync();
    const op = await db.outbox.where('entityId').equals(learner.id).first();
    expect(op?.nextAttemptAt).toBe(clock + 5_000);

    clock += 1_000; // not yet due
    const early = await engine().sync();
    expect(early.deferred).toBe(1);
    expect(remote.calls.filter((c) => c === 'createLearner')).toHaveLength(1);

    clock += 5_000;
    const due = await engine().sync();
    expect(due.synced).toBe(1);
  });

  it('pauses on expired sign-in without failing or losing work', async () => {
    const learner = await createLearner(db, { displayName: 'Dino', avatar: 'frog', gradeLevel: 3 });
    await readAttempt(learner.id);
    remote.expireAfterCalls = 2; // fetchAccess + createLearner succeed, then the token expires
    const report = await engine().sync();
    expect(report.phase).toBe('auth_required');
    const ops = await db.outbox.toArray();
    expect(ops.filter((o) => o.status === 'failed')).toHaveLength(0);
    const submit = ops.find((o) => o.type === 'session.submit');
    expect(submit?.status).toBe('pending');
    expect(submit?.attempts).toBe(0);
    expect((await engine().state()).phase).toBe('auth_required');

    remote.auth = 'ok';
    remote.expireAfterCalls = null;
    expect((await engine().sync()).synced).toBe(1);
  });

  it('never syncs one account\'s data while another account is signed in', async () => {
    await createLearner(db, { displayName: 'Eli', avatar: 'owl', gradeLevel: 1 });
    remote.userId = '22222222-2222-4222-8222-222222222222';
    const report = await engine().sync();
    expect(report.phase).toBe('identity_mismatch');
    expect(remote.calls).not.toContain('createLearner');
  });

  it('revalidates access before syncing and keeps the data when access was revoked', async () => {
    const learner = await createLearner(db, { displayName: 'Fe', avatar: 'bird', gradeLevel: 1 });
    await engine().sync();
    const { session } = await readAttempt(learner.id);
    remote.learnerIds.delete(learner.id); // e.g. removed from the class by the teacher
    const report = await engine().sync();
    expect(report.failed).toBe(1);
    const op = await db.outbox.where('entityId').equals(session.id).first();
    expect(op?.status).toBe('failed');
    expect(op?.lastError).toMatch(/kept on this device/);
    expect(remote.calls).not.toContain('submitSession');
    expect(await db.sessions.get(session.id)).toBeDefined();
  });

  it('marks a recording uploaded only after the server confirms it', async () => {
    const learner = await createLearner(db, { displayName: 'Gia', avatar: 'whale', gradeLevel: 2 });
    const { session } = await readAttempt(learner.id, { audio: true });
    expect((await db.sessions.get(session.id))?.audio.status).toBe('queued');

    // Upload succeeds, confirmation is lost.
    remote.failWith = null;
    const realConfirm = remote.confirmAudio.bind(remote);
    let failConfirm = true;
    remote.confirmAudio = async (...args) => {
      if (failConfirm) {
        failConfirm = false;
        throw new RemoteError('network', 'lost');
      }
      return realConfirm(...args);
    };
    await engine().sync();
    expect(remote.storage.size).toBe(1);
    expect((await db.sessions.get(session.id))?.audio.status).toBe('queued');

    clock += 60_000;
    await engine().sync();
    expect(remote.confirmedAudio.has(session.id)).toBe(true);
    expect((await db.sessions.get(session.id))?.audio.status).toBe('uploaded');
    expect(remote.storage.size).toBe(1);
  });

  it('does not upload recordings when sharing is not allowed', async () => {
    const learner = await createLearner(db, { displayName: 'Hana', avatar: 'star', gradeLevel: 1 });
    const { session } = await readAttempt(learner.id, { audio: true });
    await engine({ shouldUploadAudio: () => false }).sync();
    expect(remote.storage.size).toBe(0);
    expect(remote.sessions.get(session.id)?.audio_status).toBe('local_only');
    expect((await db.sessions.get(session.id))?.audio.status).toBe('local');
    expect(await db.outbox.where('type').equals('audio.upload').count()).toBe(0);
  });

  it('surfaces story-edit conflicts instead of overwriting', async () => {
    const storyId = '33333333-3333-4333-8333-333333333333';
    const base = { id: storyId, draft_title: 'Old', draft_body: 'Text.', draft_summary: '', language: 'en' as const, grade_level: 1, topic: '', revision: 1, updated_at: '' };
    remote.stories.set(storyId, { ...base, revision: 2, draft_title: 'Changed by co-teacher' });
    const op = newOp('story.update', storyId, null, {
      storyId, expectedRevision: 1, fields: { draft_title: 'Mine', draft_body: 'My text.', draft_summary: '', language: 'en', grade_level: 1, topic: '' },
    });
    await db.outbox.add(op);
    await db.storyDrafts.put({ storyId, title: 'Mine', body: 'My text.', summary: '', language: 'en', gradeLevel: 1, topic: '', baseRevision: 1, updatedAt: '', pendingOpId: op.opId });

    const report = await engine().sync();
    expect(report.conflicts).toBe(1);
    expect(remote.stories.get(storyId)?.draft_title).toBe('Changed by co-teacher');
    expect((await db.outbox.get(op.opId))?.status).toBe('conflict');

    await resolveStoryConflict(db, op.opId, 'overwrite');
    await engine().sync();
    expect(remote.stories.get(storyId)).toMatchObject({ draft_title: 'Mine', revision: 3 });
  });

  it('keeping the server version replaces the local draft', async () => {
    const storyId = '44444444-4444-4444-8444-444444444444';
    remote.stories.set(storyId, { id: storyId, draft_title: 'Server', draft_body: 'Server text.', draft_summary: '', language: 'en', grade_level: 2, topic: '', revision: 5, updated_at: '' });
    const op = newOp('story.update', storyId, null, {
      storyId, expectedRevision: 4, fields: { draft_title: 'Local', draft_body: 'Local.', draft_summary: '', language: 'en', grade_level: 2, topic: '' },
    });
    await db.outbox.add(op);
    await engine().sync();
    await resolveStoryConflict(db, op.opId, 'keep_server');
    expect(await db.outbox.get(op.opId)).toBeUndefined();
    expect(await db.storyDrafts.get(storyId)).toMatchObject({ title: 'Server', baseRevision: 5 });
  });

  it('synchronizes word removals as tombstones', async () => {
    const learner = await createLearner(db, { displayName: 'Ivy', avatar: 'owl', gradeLevel: 1 });
    const { word } = await saveWord(db, { learnerId: learner.id, language: 'en', word: 'Puddle', vocabularyEntryId: null, storyVersionId: story.id });
    await removeWord(db, word.id);
    await engine().sync();
    expect(remote.words.get(`${learner.id}|puddle`)?.archivedAt).not.toBeNull();
    expect((await db.learnerWords.get(word.id))?.archivedAt).not.toBeNull();
  });

  it('queues a teacher-review request after the attempt and applies it once', async () => {
    const learner = await createLearner(db, { displayName: 'Lia', avatar: 'owl', gradeLevel: 1 });
    const { session } = await readAttempt(learner.id);
    await requestTeacherReview(db, session.id);
    await requestTeacherReview(db, session.id); // double tap
    expect(await db.outbox.where('type').equals('session.review').count()).toBe(1);
    await engine().sync();
    expect(remote.reviewRequests.has(session.id)).toBe(true);
    expect(remote.calls.filter((c) => c === 'requestReview')).toHaveLength(1);
  });

  it('runs one pass at a time', async () => {
    await createLearner(db, { displayName: 'Jo', avatar: 'owl', gradeLevel: 1 });
    const e = engine();
    const [a, b] = await Promise.all([e.sync(), e.sync()]);
    expect(a).toBe(b);
    expect(remote.calls.filter((c) => c === 'createLearner')).toHaveLength(1);
  });

  it('manual "Sync now" retries failed items', async () => {
    const learner = await createLearner(db, { displayName: 'Kai', avatar: 'owl', gradeLevel: 1 });
    const original = remote.createLearner.bind(remote);
    let reject = true;
    remote.createLearner = async (...args) => {
      if (reject) {
        reject = false;
        throw new RemoteError('validation', 'temporarily rejected');
      }
      return original(...args);
    };
    await engine().sync();
    expect((await db.outbox.where('entityId').equals(learner.id).first())?.status).toBe('failed');
    await engine().sync();
    expect((await db.outbox.where('entityId').equals(learner.id).first())?.status).toBe('failed');
    await engine().sync({ manual: true });
    expect((await db.outbox.where('entityId').equals(learner.id).first())?.status).toBe('synced');
  });
});
