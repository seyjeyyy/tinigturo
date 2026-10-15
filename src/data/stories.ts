import type { StoryVersionRecord } from '../domain/types';
import { guardStorage, StorageFullError } from '../db/errors';
import type { TinigDb } from '../db/localDb';
import { nowIso } from '../lib/ids';
import type { LanguageCode } from '../text/language';
import { MAX_STORY_CHARS, sanitizeStoryText } from '../text/tokenize';

export interface StoryFilters {
  language?: LanguageCode | 'all';
  gradeLevel?: number | 'all';
  topic?: string | 'all';
}

export async function listLocalStories(db: TinigDb, filters: StoryFilters = {}): Promise<StoryVersionRecord[]> {
  const stories = await db.stories.toArray();
  // Keep only the newest downloaded version of each story in the library.
  const newest = new Map<string, StoryVersionRecord>();
  for (const story of stories) {
    const current = newest.get(story.storyId);
    if (!current || story.versionNumber > current.versionNumber) newest.set(story.storyId, story);
  }
  return [...newest.values()]
    .filter((s) => !filters.language || filters.language === 'all' || s.language === filters.language)
    .filter((s) => !filters.gradeLevel || filters.gradeLevel === 'all' || s.gradeLevel === filters.gradeLevel)
    .filter((s) => !filters.topic || filters.topic === 'all' || s.topic === filters.topic)
    .sort((a, b) => a.gradeLevel - b.gradeLevel || a.title.localeCompare(b.title));
}

/** Validates content received from the server before storing it. Story text is plain text only. */
export function validateStoryContent(story: Pick<StoryVersionRecord, 'title' | 'body' | 'language' | 'gradeLevel'>): string | null {
  if (!story.title.trim() || story.title.length > 120) return 'Story title is missing or too long.';
  if (!story.body.trim()) return 'Story text is empty.';
  if (story.body.length > MAX_STORY_CHARS) return 'Story text is too long.';
  if (story.language !== 'en' && story.language !== 'fil') return 'Unsupported story language.';
  if (!Number.isInteger(story.gradeLevel) || story.gradeLevel < 1 || story.gradeLevel > 6) return 'Invalid grade level.';
  return null;
}

/** Estimated free space check before a download. Browsers may still evict data later. */
export async function hasRoomFor(bytes: number): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return true;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota === undefined || usage === undefined) return true;
    return quota - usage > bytes * 1.5 + 1_000_000;
  } catch {
    return true;
  }
}

export async function saveDownloadedStory(db: TinigDb, story: Omit<StoryVersionRecord, 'source' | 'downloadedAt' | 'sizeBytes'>): Promise<void> {
  const problem = validateStoryContent(story);
  if (problem) throw new Error(problem);
  const record: StoryVersionRecord = {
    ...story,
    title: story.title.trim(),
    body: sanitizeStoryText(story.body),
    source: 'downloaded',
    downloadedAt: nowIso(),
    sizeBytes: new Blob([story.body]).size,
  };
  if (!(await hasRoomFor(record.sizeBytes))) throw new StorageFullError();
  await guardStorage(() =>
    db.transaction('rw', db.stories, db.downloads, async () => {
      await db.stories.put(record);
      await db.downloads.put({
        id: `story:${record.id}`,
        kind: 'story',
        label: record.title,
        status: 'ready',
        progress: 1,
        bytes: record.sizeBytes,
        error: null,
        updatedAt: nowIso(),
        refId: record.id,
      });
    }),
  );
}

/**
 * Removes downloaded story content only. Reading attempts, recordings, words and
 * unsynced work are never touched; they keep their reference to the story version.
 */
export async function removeStoryDownload(db: TinigDb, storyVersionId: string): Promise<{ removed: boolean; reason?: string }> {
  const story = await db.stories.get(storyVersionId);
  if (!story) return { removed: false, reason: 'Not downloaded.' };
  if (story.source === 'bundled') return { removed: false, reason: 'Starter stories are part of the app.' };
  const inProgress = await db.sessions
    .where('storyVersionId').equals(storyVersionId)
    .filter((s) => s.status === 'in_progress')
    .count();
  if (inProgress > 0) return { removed: false, reason: 'A reading of this story is still in progress.' };
  await db.transaction('rw', db.stories, db.downloads, async () => {
    await db.stories.delete(storyVersionId);
    await db.downloads.delete(`story:${storyVersionId}`);
  });
  return { removed: true };
}
