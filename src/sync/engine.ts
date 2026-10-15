import type { OutboxOp, ReadingSessionRecord } from '../domain/types';
import { kvGet, kvSet, type TinigDb } from '../db/localDb';
import { RemoteError, classifyError } from '../backend/errors';
import type { AccessSummary, RemoteApi, ServerAward, StoryUpdateFields } from '../backend/remoteApi';
import { nowIso } from '../lib/ids';
import { backoffDelay, pruneSyncedOps } from './outbox';
import { buildSessionPayload } from './payload';
import { rewardId } from '../rewards/rules';
import type { LanguageCode } from '../text/language';

export const MAX_AUTOMATIC_ATTEMPTS = 8;

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'auth_required' | 'identity_mismatch' | 'error' | 'not_configured';

export interface SyncState {
  phase: SyncPhase;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  message: string | null;
}

export const INITIAL_SYNC_STATE: SyncState = { phase: 'idle', lastSuccessAt: null, lastAttemptAt: null, message: null };

export interface SyncReport {
  phase: SyncPhase;
  synced: number;
  failed: number;
  conflicts: number;
  deferred: number;
}

export interface SyncEngineOptions {
  db: TinigDb;
  remote: RemoteApi;
  /** The account this local partition belongs to. Sync never runs under another identity. */
  expectedUserId: string;
  isOnline?: () => boolean;
  now?: () => number;
  random?: () => number;
  /** Whether recordings may be uploaded (learner/class recording policy and the user's choice). */
  shouldUploadAudio?: (session: ReadingSessionRecord) => boolean;
}

interface WordSavePayload {
  learnerId: string; language: LanguageCode; word: string; normalized: string;
  vocabularyEntryId: string | null; storyVersionId: string | null; savedAt: string;
}
interface WordArchivePayload { learnerId: string; language: LanguageCode; normalized: string; archivedAt: string }
interface WordPracticePayload { learnerId: string; language: LanguageCode; normalized: string; practicedAt: string }
interface StoryUpdatePayload { storyId: string; expectedRevision: number; fields: StoryUpdateFields }
interface LearnerCreatePayload { id: string; displayName: string; avatar: string; gradeLevel: number | null }

/**
 * Pushes the persistent outbox to the server.
 *
 * - Runs in the foreground: on launch, on reconnect, on "Sync now" and when a retry
 *   timer is due. Background Sync, where supported, only wakes the app to do the same.
 * - Every operation is idempotent server-side (op IDs + unique constraints), so a
 *   crash between "server applied" and "client recorded" is safe to retry.
 * - An expired sign-in pauses sync without failing or discarding anything.
 * - Access is revalidated with the server before any learner data is sent.
 */
export class SyncEngine {
  private running: Promise<SyncReport> | null = null;

  constructor(private readonly options: SyncEngineOptions) {}

  private get db() {
    return this.options.db;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async state(): Promise<SyncState> {
    return (await kvGet<SyncState>(this.db, 'syncState')) ?? INITIAL_SYNC_STATE;
  }

  private async setState(patch: Partial<SyncState>): Promise<void> {
    const current = await this.state();
    await kvSet(this.db, 'syncState', { ...current, ...patch });
  }

  /** Runs one sync pass; concurrent callers share the same pass. */
  sync(options: { manual?: boolean } = {}): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.run(options.manual ?? false).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /** Earliest time a pending op becomes due, so the caller can schedule a retry. */
  async nextDueAt(): Promise<number | null> {
    const pending = await this.db.outbox.where('status').equals('pending').toArray();
    if (!pending.length) return null;
    return Math.min(...pending.map((op) => op.nextAttemptAt));
  }

  private async run(manual: boolean): Promise<SyncReport> {
    const report: SyncReport = { phase: 'idle', synced: 0, failed: 0, conflicts: 0, deferred: 0 };
    const isOnline = this.options.isOnline?.() ?? (typeof navigator === 'undefined' || navigator.onLine);
    const attemptAt = new Date(this.now()).toISOString();

    if (!isOnline) {
      await this.setState({ phase: 'offline', message: 'Offline. Changes are saved on this device.' });
      return { ...report, phase: 'offline' };
    }

    await this.setState({ phase: 'syncing', lastAttemptAt: attemptAt, message: null });

    // Ops left in "syncing" by a crash or closed tab are retried; the server dedupes.
    await this.db.outbox.where('status').equals('syncing').modify({ status: 'pending' });
    if (manual) {
      await this.db.outbox.where('status').equals('failed').modify({ status: 'pending', nextAttemptAt: 0, attempts: 0 });
    }

    let access: AccessSummary;
    try {
      const auth = await this.options.remote.checkAuth();
      if (auth.status !== 'ok') {
        await this.setState({ phase: 'auth_required', message: 'Sign in again to sync. Your work is safe on this device.' });
        return { ...report, phase: 'auth_required' };
      }
      if (auth.userId !== this.options.expectedUserId) {
        await this.setState({ phase: 'identity_mismatch', message: 'A different account is signed in. Sync is paused.' });
        return { ...report, phase: 'identity_mismatch' };
      }
      access = await this.options.remote.fetchAccess();
    } catch (error) {
      return this.stopForError(classifyError(error), report);
    }

    const ops = (await this.db.outbox.where('status').equals('pending').toArray()).sort((a, b) =>
      a.createdAt === b.createdAt ? a.opId.localeCompare(b.opId) : a.createdAt.localeCompare(b.createdAt),
    );
    const now = this.now();

    for (const listed of ops) {
      // Earlier ops in this pass may have removed or changed this one.
      const op = await this.db.outbox.get(listed.opId);
      if (!op || op.status !== 'pending') continue;
      if (!manual && op.nextAttemptAt > now) {
        report.deferred++;
        continue;
      }
      const blocked = await this.blockedBy(op);
      if (blocked) {
        report.deferred++;
        continue;
      }
      // Offline access is not proof of authorization: re-check before sending.
      if (op.learnerId && op.type !== 'learner.create' && !access.learnerIds.has(op.learnerId)) {
        await this.markFailed(op, 'This learner is no longer linked to your account or class. The work is kept on this device.');
        report.failed++;
        continue;
      }

      await this.db.outbox.update(op.opId, { status: 'syncing', updatedAt: nowIso() });
      try {
        await this.execute(op, access);
        await this.db.outbox.update(op.opId, { status: 'synced', lastError: null, updatedAt: nowIso() });
        report.synced++;
      } catch (error) {
        const remoteError = classifyError(error);
        if (remoteError.kind === 'network' || remoteError.kind === 'auth') {
          await this.db.outbox.update(op.opId, {
            status: 'pending',
            attempts: remoteError.kind === 'network' ? op.attempts + 1 : op.attempts,
            nextAttemptAt: remoteError.kind === 'network' ? now + backoffDelay(op.attempts + 1, this.options.random) : 0,
            lastError: remoteError.message,
            updatedAt: nowIso(),
          });
          return this.stopForError(remoteError, report);
        }
        if (remoteError.kind === 'conflict') {
          await this.db.outbox.update(op.opId, {
            status: 'conflict', conflict: remoteError.details, lastError: remoteError.message, updatedAt: nowIso(),
          });
          report.conflicts++;
          continue;
        }
        if (remoteError.retryable) {
          const attempts = op.attempts + 1;
          if (attempts >= MAX_AUTOMATIC_ATTEMPTS) {
            await this.markFailed(op, remoteError.message, attempts);
            report.failed++;
          } else {
            await this.db.outbox.update(op.opId, {
              status: 'pending', attempts, nextAttemptAt: now + backoffDelay(attempts, this.options.random),
              lastError: remoteError.message, updatedAt: nowIso(),
            });
            report.deferred++;
          }
          continue;
        }
        await this.markFailed(op, remoteError.message, op.attempts + 1);
        report.failed++;
      }
    }

    await pruneSyncedOps(this.db, undefined, this.now());
    const finishedAt = new Date(this.now()).toISOString();
    await this.setState({
      phase: report.failed || report.conflicts ? 'error' : 'idle',
      lastSuccessAt: finishedAt,
      message: report.conflicts
        ? 'Some changes need your decision.'
        : report.failed
          ? 'Some items could not be synced.'
          : null,
    });
    return { ...report, phase: report.failed || report.conflicts ? 'error' : 'idle' };
  }

  private async stopForError(error: RemoteError, report: SyncReport): Promise<SyncReport> {
    if (error.kind === 'auth') {
      await this.setState({ phase: 'auth_required', message: 'Sign in again to sync. Your work is safe on this device.' });
      return { ...report, phase: 'auth_required' };
    }
    if (error.kind === 'network') {
      await this.setState({ phase: 'offline', message: 'Could not reach the server. Will retry.' });
      return { ...report, phase: 'offline' };
    }
    await this.setState({ phase: 'error', message: error.message });
    return { ...report, phase: 'error' };
  }

  private async markFailed(op: OutboxOp, message: string, attempts = op.attempts): Promise<void> {
    await this.db.outbox.update(op.opId, { status: 'failed', attempts, lastError: message, updatedAt: nowIso() });
    if (op.type === 'session.submit') await this.db.sessions.update(op.entityId, { sync: 'failed' });
    if (op.type === 'audio.upload') {
      const session = await this.db.sessions.get(op.entityId);
      if (session) await this.db.sessions.update(op.entityId, { audio: { ...session.audio, status: 'failed', error: message } });
    }
  }

  private async blockedBy(op: OutboxOp): Promise<boolean> {
    for (const dep of op.dependsOn) {
      const depOp = await this.db.outbox.get(dep);
      // A missing dependency was synced and pruned.
      if (depOp && depOp.status !== 'synced') return true;
    }
    return false;
  }

  private async execute(op: OutboxOp, access: AccessSummary): Promise<void> {
    const remote = this.options.remote;
    switch (op.type) {
      case 'learner.create': {
        const p = op.payload as LearnerCreatePayload;
        await remote.createLearner(op.opId, p);
        access.learnerIds.add(p.id);
        await this.db.learners.update(p.id, { cloud: 'synced' });
        return;
      }
      case 'session.submit': {
        const session = await this.db.sessions.get(op.entityId);
        if (!session) throw new RemoteError('validation', 'The attempt is missing from this device.');
        const share = this.options.shouldUploadAudio?.(session) ?? false;
        const result = await remote.submitSession(op.opId, buildSessionPayload(session, share));
        await this.db.transaction('rw', this.db.sessions, this.db.rewards, this.db.outbox, async () => {
          const patch: Partial<ReadingSessionRecord> = { sync: 'synced', updatedAt: nowIso() };
          if (result.audioStatus === 'local_only' && session.audio.status === 'queued') {
            // No recording policy allows sharing: the recording stays on this device.
            const uploads = await this.db.outbox.where('entityId').equals(session.id).filter((o) => o.type === 'audio.upload').toArray();
            for (const upload of uploads) await this.db.outbox.delete(upload.opId);
            patch.audio = { ...session.audio, status: 'local', error: 'Sharing is not allowed for this learner, so the recording stays on this device.' };
          }
          await this.db.sessions.update(session.id, patch);
          await this.applyServerAwards(session.learnerId, result.awards, session.id);
        });
        return;
      }
      case 'audio.upload': {
        const session = await this.db.sessions.get(op.entityId);
        const recording = await this.db.recordings.get(op.entityId);
        if (!session || !recording) throw new RemoteError('validation', 'The recording is no longer on this device.');
        if (!(this.options.shouldUploadAudio?.(session) ?? false)) {
          throw new RemoteError('forbidden', 'Recording sharing is turned off, so this recording stays on this device.');
        }
        const { path } = await remote.uploadAudio(session.learnerId, session.id, recording.blob, recording.mimeType);
        // Only the server's confirmation marks the upload complete.
        await remote.confirmAudio(op.opId, session.id, path);
        await this.db.sessions.update(session.id, { audio: { ...session.audio, status: 'uploaded', remotePath: path, error: null } });
        return;
      }
      case 'session.review': {
        await remote.requestReview(op.opId, op.entityId);
        return;
      }
      case 'word.save': {
        const p = op.payload as WordSavePayload;
        const result = await remote.saveWord(op.opId, p);
        await this.db.transaction('rw', this.db.learnerWords, this.db.rewards, async () => {
          const id = `${p.learnerId}|${p.language}|${p.normalized}`;
          const word = await this.db.learnerWords.get(id);
          if (word && word.savedAt <= p.savedAt) await this.db.learnerWords.update(id, { sync: 'synced' });
          await this.applyServerAwards(p.learnerId, result.awards, null);
        });
        return;
      }
      case 'word.archive': {
        const p = op.payload as WordArchivePayload;
        await remote.archiveWord(op.opId, p);
        return;
      }
      case 'word.practice': {
        await remote.recordWordPractice(op.opId, op.payload as WordPracticePayload);
        return;
      }
      case 'story.update': {
        const p = op.payload as StoryUpdatePayload;
        const server = await remote.updateStory(p.storyId, p.expectedRevision, p.fields);
        const draft = await this.db.storyDrafts.get(p.storyId);
        if (draft && draft.pendingOpId === op.opId) {
          await this.db.storyDrafts.update(p.storyId, { baseRevision: server.revision, pendingOpId: null });
        }
        return;
      }
      default:
        throw new RemoteError('validation', `Unknown operation ${String(op.type)}`);
    }
  }

  /** Server awards become "validated"; local guesses for this session that the server did not grant are marked. */
  private async applyServerAwards(learnerId: string, awards: ServerAward[], sessionId: string | null): Promise<void> {
    const confirmed = new Set<string>();
    for (const award of awards) {
      const id = rewardId(learnerId, award.badge_code, award.source_key);
      confirmed.add(id);
      const existing = await this.db.rewards.get(id);
      await this.db.rewards.put({
        id,
        learnerId,
        badgeCode: award.badge_code,
        sourceKey: award.source_key,
        sessionId: award.session_id ?? existing?.sessionId ?? null,
        awardedAt: existing?.awardedAt ?? award.awarded_at,
        status: 'validated',
      });
    }
    if (sessionId) {
      const local = await this.db.rewards.where('sessionId').equals(sessionId).toArray();
      for (const reward of local) {
        if (reward.status === 'pending' && !confirmed.has(reward.id)) {
          await this.db.rewards.update(reward.id, { status: 'not_confirmed' });
        }
      }
    }
  }
}

/** Resolves a story-edit conflict. "keep_server" drops the local edit; "overwrite" retries on top of the server revision. */
export async function resolveStoryConflict(
  db: TinigDb,
  opId: string,
  choice: 'keep_server' | 'overwrite',
): Promise<void> {
  const op = await db.outbox.get(opId);
  if (!op || op.status !== 'conflict' || op.type !== 'story.update') return;
  const server = op.conflict as { revision: number; draft_title: string; draft_body: string; draft_summary: string; language: LanguageCode; grade_level: number; topic: string } | null;
  const payload = op.payload as StoryUpdatePayload;
  await db.transaction('rw', db.outbox, db.storyDrafts, async () => {
    if (choice === 'keep_server' || !server) {
      await db.outbox.delete(opId);
      if (server) {
        await db.storyDrafts.put({
          storyId: payload.storyId,
          title: server.draft_title,
          body: server.draft_body,
          summary: server.draft_summary,
          language: server.language,
          gradeLevel: server.grade_level,
          topic: server.topic,
          baseRevision: server.revision,
          updatedAt: nowIso(),
          pendingOpId: null,
        });
      }
      return;
    }
    await db.outbox.update(opId, {
      status: 'pending',
      payload: { ...payload, expectedRevision: server.revision },
      conflict: null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      updatedAt: nowIso(),
    });
  });
}
