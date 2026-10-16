import type { LearnerProfile, LocalRecording, StoryVersionRecord } from '../domain/types';
import { guardStorage } from '../db/errors';
import { kvGet, kvSet, type TinigDb } from '../db/localDb';
import { metaDelete, metaGet, metaSet } from '../db/metaDb';
import { nowIso } from '../lib/ids';
import { newOp } from '../sync/outbox';

/**
 * Linking device-only readers into an account (local partition `device` → `user:<id>`).
 *
 * - Nothing moves unless an adult confirms the destination account in the UI; signing
 *   in never moves readers by itself.
 * - Learner, attempt and word IDs are preserved, so the server's unique keys prevent
 *   duplicates on retries, and `create_learner` refuses an ID that belongs to anyone
 *   else (no attaching to another family's learner).
 * - Each reader is copied into the account in ONE transaction together with its sync
 *   operations, and only then removed from the device partition. A journal in the
 *   device metadata lets an interrupted link finish later; re-running is harmless.
 * - Unsynced recordings stay on this device: they are uploaded only if recording
 *   sharing is turned on and allowed for the reader, like any other recording.
 */

export interface LinkCandidate {
  learner: LearnerProfile;
  savedReadings: number;
  unfinishedReadings: number;
  recordings: number;
  words: number;
  badges: number;
}

export interface LinkJournal {
  userId: string;
  email: string | null;
  learnerIds: string[];
  done: string[];
  startedAt: string;
}

export interface LinkReport {
  linked: string[];
  alreadyLinked: string[];
  missing: string[];
}

const JOURNAL_KEY = 'linkJournal';

export async function listLinkCandidates(source: TinigDb): Promise<LinkCandidate[]> {
  if (source.partition !== 'device') return [];
  const learners = (await source.learners.toArray()).filter((l) => !l.archivedAt);
  const out: LinkCandidate[] = [];
  for (const learner of learners) {
    const sessions = await source.sessions.where('learnerId').equals(learner.id).toArray();
    const recordings = await source.recordings.bulkGet(sessions.map((s) => s.id));
    out.push({
      learner,
      savedReadings: sessions.filter((s) => s.status === 'saved').length,
      unfinishedReadings: sessions.filter((s) => s.status === 'in_progress').length,
      recordings: recordings.filter(Boolean).length,
      words: await source.learnerWords.where('learnerId').equals(learner.id).filter((w) => !w.archivedAt).count(),
      badges: await source.rewards.where('learnerId').equals(learner.id).count(),
    });
  }
  return out.sort((a, b) => a.learner.displayName.localeCompare(b.learner.displayName));
}

export async function pendingLinkJournal(userId: string): Promise<LinkJournal | null> {
  const journal = await metaGet<LinkJournal>(JOURNAL_KEY);
  return journal && journal.userId === userId && journal.done.length < journal.learnerIds.length ? journal : null;
}

function assertPartitions(source: TinigDb, target: TinigDb, userId: string): void {
  if (source.partition !== 'device') throw new Error('Only readers saved on this device can be linked.');
  if (target.partition !== `user:${userId}`) throw new Error('Readers can only be linked into the signed-in account.');
}

/** Copies one reader with everything it owns, then removes it from the device partition. */
async function linkOne(source: TinigDb, target: TinigDb, learnerId: string): Promise<'linked' | 'already' | 'missing'> {
  const learner = await source.learners.get(learnerId);
  const alreadyInTarget = Boolean(await target.learners.get(learnerId));
  if (!learner) return alreadyInTarget ? 'already' : 'missing';

  const sessions = await source.sessions.where('learnerId').equals(learnerId).toArray();
  const sessionIds = sessions.map((s) => s.id);
  if (!alreadyInTarget) {
    const recordings = (await source.recordings.bulkGet(sessionIds)).filter((r): r is LocalRecording => Boolean(r));
    const chunks = sessionIds.length ? await source.audioChunks.where('sessionId').anyOf(sessionIds).toArray() : [];
    const words = await source.learnerWords.where('learnerId').equals(learnerId).toArray();
    const rewards = await source.rewards.where('learnerId').equals(learnerId).toArray();
    const stories = (await source.stories.bulkGet([...new Set(sessions.map((s) => s.storyVersionId))]))
      .filter((s): s is StoryVersionRecord => Boolean(s));

    await guardStorage(() =>
      target.transaction('rw', [target.learners, target.sessions, target.recordings, target.audioChunks, target.learnerWords, target.rewards, target.outbox, target.stories], async () => {
        if (await target.learners.get(learnerId)) return; // finished by an earlier, interrupted run
        const create = newOp('learner.create', learnerId, learnerId, {
          id: learnerId, displayName: learner.displayName, avatar: learner.avatar, gradeLevel: learner.gradeLevel,
        });
        await target.learners.put({ ...learner, origin: 'account', cloud: 'pending', classIds: [] });
        await target.outbox.add(create);
        for (const story of stories) {
          if (!(await target.stories.get(story.id))) await target.stories.put(story);
        }
        for (const session of sessions) {
          // Unfinished attempts come along with their audio and can be saved from Home.
          await target.sessions.put({ ...session, sync: 'pending', updatedAt: nowIso() });
          if (session.status === 'saved') {
            await target.outbox.add(newOp('session.submit', session.id, learnerId, { sessionId: session.id }, [create.opId]));
          }
        }
        if (recordings.length) await target.recordings.bulkPut(recordings);
        if (chunks.length) await target.audioChunks.bulkPut(chunks);
        for (const word of words) {
          if (word.archivedAt) {
            await target.learnerWords.put({ ...word, sync: 'local_only' }); // removed before it was ever synced
            continue;
          }
          await target.learnerWords.put({ ...word, sync: 'pending' });
          const save = newOp('word.save', word.id, learnerId, {
            learnerId, language: word.language, word: word.word, normalized: word.normalized,
            vocabularyEntryId: word.vocabularyEntryId, storyVersionId: word.storyVersionId, savedAt: word.savedAt,
          }, [create.opId]);
          await target.outbox.add(save);
          // Practice done before linking is kept: one op per practice, as it happened.
          for (let i = 0; i < word.practiceCount; i++) {
            await target.outbox.add(newOp('word.practice', word.id, learnerId, {
              learnerId, language: word.language, normalized: word.normalized, practicedAt: word.lastPracticedAt ?? word.savedAt,
            }, [save.opId]));
          }
        }
        // Device badges stay "waiting to be checked" until the server confirms them.
        if (rewards.length) await target.rewards.bulkPut(rewards.map((r) => (r.status === 'validated' ? r : { ...r, status: 'pending' as const })));
      }),
    );
  }

  // Only now is the device copy removed: a crash before this point leaves both copies,
  // and the next run removes the device one without copying twice.
  await source.transaction('rw', [source.learners, source.sessions, source.recordings, source.audioChunks, source.learnerWords, source.rewards, source.kv], async () => {
    if (sessionIds.length) {
      await source.recordings.bulkDelete(sessionIds);
      await source.audioChunks.where('sessionId').anyOf(sessionIds).delete();
      await source.sessions.bulkDelete(sessionIds);
    }
    await source.learnerWords.where('learnerId').equals(learnerId).delete();
    await source.rewards.where('learnerId').equals(learnerId).delete();
    await source.learners.delete(learnerId);
    if ((await kvGet<string | null>(source, 'activeLearnerId')) === learnerId) await kvSet(source, 'activeLearnerId', null);
  });
  return alreadyInTarget ? 'already' : 'linked';
}

async function run(source: TinigDb, target: TinigDb, journal: LinkJournal): Promise<LinkReport> {
  const report: LinkReport = { linked: [], alreadyLinked: [], missing: [] };
  for (const learnerId of journal.learnerIds) {
    if (journal.done.includes(learnerId)) continue;
    const outcome = await linkOne(source, target, learnerId);
    if (outcome === 'linked') report.linked.push(learnerId);
    else if (outcome === 'already') report.alreadyLinked.push(learnerId);
    else report.missing.push(learnerId);
    journal.done.push(learnerId);
    await metaSet(JOURNAL_KEY, journal);
  }
  await metaDelete(JOURNAL_KEY);
  return report;
}

/**
 * Links the chosen device-only readers into the signed-in account. The caller must
 * have shown the adult what moves and to which account, and must have confirmed with
 * the server that this account is the one signed in.
 */
export async function linkDeviceLearners(input: {
  source: TinigDb; target: TinigDb; userId: string; email: string | null; learnerIds: string[];
}): Promise<LinkReport> {
  assertPartitions(input.source, input.target, input.userId);
  const existing = await metaGet<LinkJournal>(JOURNAL_KEY);
  if (existing && existing.done.length < existing.learnerIds.length && existing.userId !== input.userId) {
    throw new Error('Another account’s linking is unfinished on this device. Sign in to that account to finish it first.');
  }
  const journal: LinkJournal = {
    userId: input.userId, email: input.email, learnerIds: [...new Set(input.learnerIds)], done: [], startedAt: nowIso(),
  };
  await metaSet(JOURNAL_KEY, journal);
  return run(input.source, input.target, journal);
}

/** Finishes a link that was interrupted (closed tab, crash, full storage fixed). */
export async function resumeLinking(input: { source: TinigDb; target: TinigDb; userId: string }): Promise<LinkReport | null> {
  assertPartitions(input.source, input.target, input.userId);
  const journal = await pendingLinkJournal(input.userId);
  if (!journal) return null;
  return run(input.source, input.target, journal);
}
