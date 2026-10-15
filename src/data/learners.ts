import { DEFAULT_READING_PREFERENCES, type AvatarId, type LearnerProfile, type ReadingPreferences } from '../domain/types';
import { guardStorage } from '../db/errors';
import type { TinigDb } from '../db/localDb';
import { nowIso, uuid } from '../lib/ids';
import { newOp } from '../sync/outbox';

export function partitionSyncs(db: TinigDb): boolean {
  return db.partition !== 'device';
}

export async function listLearners(db: TinigDb): Promise<LearnerProfile[]> {
  const all = await db.learners.toArray();
  return all.filter((l) => !l.archivedAt).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface NewLearnerInput {
  displayName: string;
  avatar: AvatarId;
  gradeLevel: number | null;
}

export function validateLearnerName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Please type a name.';
  if (trimmed.length > 40) return 'Use 40 letters or fewer.';
  return null;
}

/**
 * Creates a learner profile on this device. In an account partition the learner is
 * also queued for creation on the server, atomically with the local write.
 */
export async function createLearner(db: TinigDb, input: NewLearnerInput): Promise<LearnerProfile> {
  const error = validateLearnerName(input.displayName);
  if (error) throw new Error(error);
  const syncs = partitionSyncs(db);
  const learner: LearnerProfile = {
    id: uuid(),
    displayName: input.displayName.trim(),
    avatar: input.avatar,
    gradeLevel: input.gradeLevel,
    createdAt: nowIso(),
    origin: syncs ? 'account' : 'device',
    cloud: syncs ? 'pending' : 'local_only',
    classIds: [],
    preferences: { ...DEFAULT_READING_PREFERENCES },
    archivedAt: null,
  };
  await guardStorage(() =>
    db.transaction('rw', db.learners, db.outbox, async () => {
      await db.learners.add(learner);
      if (syncs) {
        await db.outbox.add(
          newOp('learner.create', learner.id, learner.id, {
            id: learner.id, displayName: learner.displayName, avatar: learner.avatar, gradeLevel: learner.gradeLevel,
          }),
        );
      }
    }),
  );
  return learner;
}

export async function updatePreferences(db: TinigDb, learnerId: string, preferences: ReadingPreferences): Promise<void> {
  await guardStorage(() => db.learners.update(learnerId, { preferences }));
}

/** Learner-creation op for this learner, if it has not been synced yet (sessions depend on it). */
export async function pendingLearnerOp(db: TinigDb, learnerId: string): Promise<string | null> {
  const op = await db.outbox
    .where('entityId').equals(learnerId)
    .filter((o) => o.type === 'learner.create' && o.status !== 'synced')
    .first();
  return op?.opId ?? null;
}
