import type { OutboxOp, OutboxOpType } from '../domain/types';
import type { TinigDb } from '../db/localDb';
import { uuid } from '../lib/ids';

let lastOpTime = 0;

/**
 * Strictly increasing timestamps, so ops created in the same millisecond (for
 * example "save word" then "remove word") keep their order when synced.
 */
function monotonicIso(): string {
  const now = Math.max(Date.now(), lastOpTime + 1);
  lastOpTime = now;
  return new Date(now).toISOString();
}

export function newOp<P>(
  type: OutboxOpType,
  entityId: string,
  learnerId: string | null,
  payload: P,
  dependsOn: string[] = [],
): OutboxOp<P> {
  const now = monotonicIso();
  return {
    opId: uuid(),
    type,
    entityId,
    learnerId,
    payload,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    dependsOn,
    conflict: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface UnsyncedSummary {
  total: number;
  sessions: number;
  recordings: number;
  words: number;
  other: number;
  conflicts: number;
  failed: number;
}

/** Everything not yet acknowledged by the server, for sign-out and status displays. */
export async function unsyncedSummary(db: TinigDb): Promise<UnsyncedSummary> {
  const ops = await db.outbox.where('status').anyOf('pending', 'syncing', 'conflict', 'failed').toArray();
  const summary: UnsyncedSummary = { total: ops.length, sessions: 0, recordings: 0, words: 0, other: 0, conflicts: 0, failed: 0 };
  for (const op of ops) {
    if (op.type === 'session.submit') summary.sessions++;
    else if (op.type === 'audio.upload') summary.recordings++;
    else if (op.type.startsWith('word.')) summary.words++;
    else summary.other++;
    if (op.status === 'conflict') summary.conflicts++;
    if (op.status === 'failed') summary.failed++;
  }
  return summary;
}

/** Removes acknowledged operations older than the retention window. */
export async function pruneSyncedOps(db: TinigDb, olderThanMs = 7 * 24 * 3600 * 1000, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - olderThanMs).toISOString();
  return db.outbox.where('status').equals('synced').filter((op) => op.updatedAt < cutoff).delete();
}

/** Exponential backoff with jitter: 5 s, 10 s, 20 s ... capped at 30 minutes. */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const base = 5_000;
  const max = 30 * 60_000;
  const exp = Math.min(max, base * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (0.5 + random() * 0.5));
}
