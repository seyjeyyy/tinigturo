import { fetchAccessibleLearners, fetchAssignments, fetchMemberships, fetchStoryVersion } from '../backend/accountApi';
import { fetchRosterForDevice } from '../backend/teacherApi';
import { requireSupabase } from '../backend/supabaseClient';
import { DEFAULT_READING_PREFERENCES, AVATARS, type AvatarId, type LearnerProfile } from '../domain/types';
import type { TinigDb } from '../db/localDb';
import { nowIso } from '../lib/ids';
import { saveDownloadedStory } from './stories';

function safeAvatar(value: string): AvatarId {
  return (AVATARS.some((a) => a.id === value) ? value : 'owl') as AvatarId;
}

/**
 * Pulls what this account may see from the server into the local partition:
 * learners, class memberships, assignments and assigned stories. Runs only online and
 * only with a valid session; RLS decides what comes back.
 */
export async function refreshFromServer(db: TinigDb, device: { mode: 'personal' | 'shared_classroom'; classId: string | null }): Promise<void> {
  const { data } = await requireSupabase().rpc('my_access');
  const access = data as { guardian_learner_ids: string[] } | null;
  if (!access) return;
  const existing = new Map((await db.learners.toArray()).map((l) => [l.id, l]));

  const upsert = async (id: string, fields: Pick<LearnerProfile, 'displayName' | 'avatar' | 'gradeLevel' | 'origin' | 'classIds'>) => {
    const local = existing.get(id);
    await db.learners.put({
      id,
      createdAt: local?.createdAt ?? nowIso(),
      preferences: local?.preferences ?? { ...DEFAULT_READING_PREFERENCES },
      cloud: 'synced',
      archivedAt: null,
      ...fields,
    });
  };

  if (device.mode === 'shared_classroom' && device.classId) {
    const roster = await fetchRosterForDevice(device.classId);
    const ids = new Set(roster.map((r) => r.learner_id));
    for (const row of roster) {
      if (!row.learners) continue;
      await upsert(row.learner_id, {
        displayName: row.learners.display_name, avatar: safeAvatar(row.learners.avatar), gradeLevel: row.learners.grade_level,
        origin: 'class_roster', classIds: [device.classId],
      });
    }
    // Learners removed from the roster are hidden, not deleted, so unsynced work is kept.
    for (const learner of existing.values()) {
      if (learner.origin === 'class_roster' && !ids.has(learner.id) && !learner.archivedAt) {
        await db.learners.update(learner.id, { archivedAt: nowIso() });
      }
    }
  } else {
    const guardianIds = new Set(access.guardian_learner_ids ?? []);
    const [learners, memberships] = await Promise.all([fetchAccessibleLearners(), fetchMemberships()]);
    for (const row of learners) {
      if (!guardianIds.has(row.id) || row.archived_at) continue;
      await upsert(row.id, {
        displayName: row.display_name, avatar: safeAvatar(row.avatar), gradeLevel: row.grade_level, origin: 'account',
        classIds: memberships.filter((m) => m.learner_id === row.id && m.status === 'active').map((m) => m.class_id),
      });
    }
  }

  const assignments = await fetchAssignments();
  await db.transaction('rw', db.assignments, async () => {
    await db.assignments.clear();
    await db.assignments.bulkPut(assignments);
  });

  // Assigned stories are downloaded so they can be read offline.
  const local = new Set((await db.stories.toCollection().primaryKeys()) as string[]);
  for (const assignment of assignments) {
    if (assignment.archivedAt || local.has(assignment.storyVersionId)) continue;
    try {
      await saveDownloadedStory(db, await fetchStoryVersion(assignment.storyVersionId));
      local.add(assignment.storyVersionId);
    } catch {
      // Best effort; the library shows a download button.
    }
  }
}
