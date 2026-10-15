import { StreamingAligner, type TranscriptLog } from '../alignment/aligner';
import { assessAttempt, unassessedSummary, type AssessmentSummary, type AttemptTiming, type WordResult } from '../assessment/scoring';
import type { LocalReward, ReadingSessionRecord, RecognitionInfo, StoryVersionRecord } from '../domain/types';
import { guardStorage } from '../db/errors';
import type { TinigDb } from '../db/localDb';
import { localDay, nowIso, uuid } from '../lib/ids';
import { evaluateSessionAwards, rewardId, type SessionForRewards } from '../rewards/rules';
import { newOp } from '../sync/outbox';
import { tokenizePassage } from '../text/tokenize';
import { partitionSyncs, pendingLearnerOp } from './learners';

export const ZERO_TIMING: AttemptTiming = { activeMs: 0, pausedMs: 0, interruptedMs: 0, assessedMs: 0 };

export interface StartSessionInput {
  learnerId: string;
  story: StoryVersionRecord;
  assignmentId: string | null;
  mode: 'read_aloud' | 'listen';
  recognition: RecognitionInfo;
  startedAt?: Date;
}

/** Persists an in-progress attempt immediately, so an interruption can be recovered. */
export async function startSession(db: TinigDb, input: StartSessionInput): Promise<ReadingSessionRecord> {
  const started = input.startedAt ?? new Date();
  const session: ReadingSessionRecord = {
    id: uuid(),
    learnerId: input.learnerId,
    storyId: input.story.storyId,
    storyVersionId: input.story.id,
    assignmentId: input.assignmentId,
    mode: input.mode,
    status: 'in_progress',
    startedAt: started.toISOString(),
    endedAt: null,
    localDay: localDay(started),
    timing: { ...ZERO_TIMING },
    recognition: input.recognition,
    transcript: null,
    assessment: null,
    wordResults: null,
    audio: { status: input.mode === 'read_aloud' ? 'recording' : 'none', mimeType: null, sizeBytes: null, remotePath: null, error: null },
    reviewRequested: false,
    recovered: false,
    sync: partitionSyncs(db) ? 'pending' : 'local_only',
    updatedAt: nowIso(),
  };
  await guardStorage(() => db.sessions.add(session));
  return session;
}

export async function appendAudioChunk(db: TinigDb, sessionId: string, seq: number, blob: Blob, mimeType: string): Promise<void> {
  await guardStorage(() => db.audioChunks.put({ sessionId, seq, blob, mimeType }));
}

/** Periodic checkpoint of timing and transcript for crash recovery. */
export async function checkpointSession(db: TinigDb, sessionId: string, timing: AttemptTiming, transcript: TranscriptLog | null): Promise<void> {
  await guardStorage(() => db.sessions.update(sessionId, { timing, transcript, updatedAt: nowIso() }));
}

export async function assembleRecording(db: TinigDb, sessionId: string): Promise<{ blob: Blob; mimeType: string } | null> {
  const chunks = await db.audioChunks.where('sessionId').equals(sessionId).sortBy('seq');
  if (!chunks.length) return null;
  const mimeType = chunks[0].mimeType;
  return { blob: new Blob(chunks.map((c) => c.blob), { type: mimeType }), mimeType };
}

function toRewardInput(s: Pick<ReadingSessionRecord, 'id' | 'storyId' | 'storyVersionId' | 'localDay' | 'mode' | 'assessment' | 'startedAt'>): SessionForRewards & { startedAt: string } {
  return {
    id: s.id,
    storyId: s.storyId,
    storyVersionId: s.storyVersionId,
    localDay: s.localDay,
    mode: s.mode,
    assessmentStatus: s.assessment?.status ?? null,
    completion: s.assessment?.completion ?? null,
    cwpm: s.assessment?.cwpm ?? null,
    startedAt: s.startedAt,
  };
}

export interface FinalizeInput {
  sessionId: string;
  endedAt?: Date;
  timing: AttemptTiming;
  transcript: TranscriptLog | null;
  assessment: AssessmentSummary;
  wordResults: WordResult[] | null;
  /** A complete recording, if one was produced. Otherwise saved chunks are assembled. */
  recording?: { blob: Blob; mimeType: string } | null;
  shareAudio: boolean;
  recovered?: boolean;
}

/**
 * Saves a finished attempt, its recording, its pending sync operations and its local
 * (pending) rewards in one IndexedDB transaction: either everything is saved or nothing.
 */
export async function finalizeSession(db: TinigDb, input: FinalizeInput): Promise<{ session: ReadingSessionRecord; awards: LocalReward[] }> {
  const recording = input.recording ?? (await assembleRecording(db, input.sessionId));
  const learnerOp = await (async () => {
    const existing = await db.sessions.get(input.sessionId);
    return existing ? pendingLearnerOp(db, existing.learnerId) : null;
  })();

  return guardStorage(() =>
    db.transaction('rw', [db.sessions, db.recordings, db.audioChunks, db.outbox, db.rewards], async () => {
      const current = await db.sessions.get(input.sessionId);
      if (!current) throw new Error('This reading attempt no longer exists.');
      if (current.status === 'saved') return { session: current, awards: [] };

      const syncs = partitionSyncs(db);
      const session: ReadingSessionRecord = {
        ...current,
        status: 'saved',
        endedAt: (input.endedAt ?? new Date()).toISOString(),
        timing: input.timing,
        transcript: input.transcript,
        assessment: input.assessment,
        wordResults: input.wordResults,
        recovered: input.recovered ?? current.recovered,
        audio: recording
          ? { status: syncs && input.shareAudio ? 'queued' : 'local', mimeType: recording.mimeType, sizeBytes: recording.blob.size, remotePath: null, error: null }
          : { status: 'none', mimeType: null, sizeBytes: null, remotePath: null, error: null },
        sync: syncs ? 'pending' : 'local_only',
        updatedAt: nowIso(),
      };
      await db.sessions.put(session);
      if (recording) {
        await db.recordings.put({ sessionId: session.id, blob: recording.blob, mimeType: recording.mimeType, createdAt: nowIso() });
      }
      await db.audioChunks.where('sessionId').equals(session.id).delete();

      if (syncs) {
        const submit = newOp('session.submit', session.id, session.learnerId, { sessionId: session.id }, learnerOp ? [learnerOp] : []);
        await db.outbox.add(submit);
        if (recording && input.shareAudio) {
          await db.outbox.add(newOp('audio.upload', session.id, session.learnerId, { sessionId: session.id }, [submit.opId]));
        }
      }

      const history = await db.sessions
        .where('learnerId').equals(session.learnerId)
        .filter((s) => s.status === 'saved' && s.id !== session.id && s.startedAt < session.startedAt)
        .toArray();
      const candidates = evaluateSessionAwards(history.map(toRewardInput), toRewardInput(session));
      const awards: LocalReward[] = [];
      for (const candidate of candidates) {
        const id = rewardId(session.learnerId, candidate.badgeCode, candidate.sourceKey);
        if (await db.rewards.get(id)) continue;
        const reward: LocalReward = {
          id,
          learnerId: session.learnerId,
          badgeCode: candidate.badgeCode,
          sourceKey: candidate.sourceKey,
          sessionId: candidate.sessionId,
          awardedAt: nowIso(),
          status: 'pending',
        };
        await db.rewards.add(reward);
        awards.push(reward);
      }
      return { session, awards };
    }),
  );
}

/** Discards an in-progress attempt and its audio chunks (after the reader confirms). */
export async function discardSession(db: TinigDb, sessionId: string): Promise<void> {
  await db.transaction('rw', db.sessions, db.audioChunks, async () => {
    const session = await db.sessions.get(sessionId);
    if (!session || session.status !== 'in_progress') return;
    await db.audioChunks.where('sessionId').equals(sessionId).delete();
    await db.sessions.delete(sessionId);
  });
}

export async function findRecoverableSessions(db: TinigDb, learnerId: string): Promise<ReadingSessionRecord[]> {
  return db.sessions.where('learnerId').equals(learnerId).filter((s) => s.status === 'in_progress').toArray();
}

/**
 * Finishes an attempt that was interrupted (reload, crash, navigation). Uses the last
 * checkpointed transcript to reproduce the assessment and the saved audio chunks.
 */
export async function recoverSession(db: TinigDb, sessionId: string, shareAudio: boolean) {
  const session = await db.sessions.get(sessionId);
  if (!session || session.status !== 'in_progress') return null;
  const story = await db.stories.get(session.storyVersionId);
  let assessment: AssessmentSummary;
  let wordResults: WordResult[] | null = null;
  if (session.mode === 'read_aloud' && session.transcript && story && session.recognition.engine) {
    const passage = tokenizePassage(story.body, story.language);
    const result = StreamingAligner.fromLog(passage.words, story.language, session.transcript).finish();
    const assessed = assessAttempt({
      result,
      timing: session.timing,
      method: 'transcript_alignment_live',
      engine: session.recognition.engine,
    });
    assessment = assessed.summary;
    wordResults = assessed.words.length ? assessed.words : null;
  } else {
    const words = story ? tokenizePassage(story.body, story.language).words.length : 0;
    assessment = unassessedSummary(words, session.timing, session.mode === 'listen' ? 'listen_mode' : (session.recognition.reason ?? 'recognition_unavailable'));
  }
  return finalizeSession(db, {
    sessionId,
    endedAt: new Date(session.updatedAt),
    timing: session.timing,
    transcript: session.transcript,
    assessment,
    wordResults,
    shareAudio,
    recovered: true,
  });
}

export async function listSavedSessions(db: TinigDb, learnerId: string): Promise<ReadingSessionRecord[]> {
  const sessions = await db.sessions.where('learnerId').equals(learnerId).filter((s) => s.status === 'saved').toArray();
  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Deletes the on-device copy of a recording. A pending upload of it is cancelled. */
export async function deleteLocalRecording(db: TinigDb, sessionId: string): Promise<void> {
  await db.transaction('rw', db.recordings, db.sessions, db.outbox, async () => {
    const session = await db.sessions.get(sessionId);
    if (!session) return;
    await db.recordings.delete(sessionId);
    const uploads = await db.outbox.where('entityId').equals(sessionId).filter((op) => op.type === 'audio.upload' && op.status !== 'synced').toArray();
    for (const op of uploads) await db.outbox.delete(op.opId);
    const uploaded = session.audio.status === 'uploaded';
    await db.sessions.update(sessionId, {
      audio: { ...session.audio, status: uploaded ? 'uploaded' : 'deleted', error: null },
      updatedAt: nowIso(),
    });
  });
}

/**
 * Asks a teacher to review an attempt (for example when word checking was not
 * available). Queued like everything else; the server applies it once.
 */
export async function requestTeacherReview(db: TinigDb, sessionId: string): Promise<void> {
  await guardStorage(() =>
    db.transaction('rw', db.sessions, db.outbox, async () => {
      const session = await db.sessions.get(sessionId);
      if (!session || session.status !== 'saved' || session.reviewRequested) return;
      await db.sessions.update(sessionId, { reviewRequested: true, updatedAt: nowIso() });
      if (!partitionSyncs(db)) return;
      const submit = await db.outbox.where('entityId').equals(sessionId).filter((o) => o.type === 'session.submit' && o.status !== 'synced').first();
      await db.outbox.add(newOp('session.review', sessionId, session.learnerId, { sessionId }, submit ? [submit.opId] : []));
    }),
  );
}

/** Saves a Listen-and-follow session (participation only; never assessed). */
export async function saveListenSession(
  db: TinigDb,
  input: { learnerId: string; story: StoryVersionRecord; assignmentId: string | null; startedAt: Date; listenedMs: number },
) {
  const session = await startSession(db, {
    learnerId: input.learnerId, story: input.story, assignmentId: input.assignmentId, mode: 'listen',
    recognition: { plan: 'none', engine: null, reason: 'listen_mode' }, startedAt: input.startedAt,
  });
  const timing = { activeMs: input.listenedMs, pausedMs: 0, interruptedMs: 0, assessedMs: 0 };
  const words = tokenizePassage(input.story.body, input.story.language).words.length;
  return finalizeSession(db, {
    sessionId: session.id,
    timing,
    transcript: null,
    assessment: unassessedSummary(words, timing, 'listen_mode'),
    wordResults: null,
    recording: null,
    shareAudio: false,
  });
}
