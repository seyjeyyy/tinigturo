import type { StoryVersionRecord, VocabularyEntry } from '../domain/types';
import { guardStorage } from '../db/errors';
import type { TinigDb } from '../db/localDb';
import { nowIso } from '../lib/ids';
import { toNarrationTimings } from '../narration/narrationFiles';
import type { NarrationRow, VocabularyRow } from '../backend/teacherToolsApi';

/**
 * Brings reviewed teacher content onto the device for offline use: published word
 * meanings and recorded narration. Only published vocabulary is downloaded; drafts and
 * reviewed-but-unpublished entries stay on the server.
 */

export function toVocabularyEntry(row: VocabularyRow): VocabularyEntry {
  return {
    id: row.id,
    language: row.language,
    headword: row.headword,
    normalized: row.normalized,
    partOfSpeech: row.part_of_speech,
    definition: row.definition,
    example: row.example,
    syllables: row.syllables,
    syllablesVerified: row.syllables_verified && Boolean(row.syllables),
    reviewStatus: 'published',
    version: row.version,
  };
}

/** Saves published entries; a published entry replaces any local entry for the same word. */
export async function savePublishedVocabulary(db: TinigDb, rows: VocabularyRow[]): Promise<number> {
  const entries = rows.filter((r) => r.review_status === 'published').map(toVocabularyEntry);
  await guardStorage(() =>
    db.transaction('rw', db.vocabulary, db.downloads, async () => {
      for (const entry of entries) {
        const sameWord = await db.vocabulary.where('[language+normalized]').equals([entry.language, entry.normalized]).toArray();
        for (const old of sameWord) if (old.id !== entry.id) await db.vocabulary.delete(old.id);
        const existing = await db.vocabulary.get(entry.id);
        if (!existing || (existing.version ?? 0) <= (entry.version ?? 0)) await db.vocabulary.put(entry);
      }
      await db.downloads.put({
        id: 'vocabulary:published',
        kind: 'vocabulary',
        label: `Reviewed word meanings (${entries.length})`,
        status: 'ready',
        progress: 1,
        bytes: new Blob([JSON.stringify(entries)]).size,
        error: null,
        updatedAt: nowIso(),
        refId: null,
      });
    }),
  );
  return entries.length;
}

export function narrationKey(storyVersionId: string): string {
  return `narration:${storyVersionId}`;
}

/** Stores a narration recording for offline Listen mode, linked to its exact story version. */
export async function saveNarration(db: TinigDb, story: StoryVersionRecord, row: NarrationRow, blob: Blob): Promise<void> {
  if (row.story_version_id !== story.id) throw new Error('This narration belongs to a different version of the story.');
  await guardStorage(() =>
    db.transaction('rw', db.recordings, db.stories, db.downloads, async () => {
      await db.recordings.put({ sessionId: narrationKey(story.id), blob, mimeType: row.mime_type, createdAt: nowIso() });
      await db.stories.update(story.id, { narration: { audioPath: row.audio_path, timings: toNarrationTimings(row.timings) } });
      await db.downloads.put({
        id: narrationKey(story.id),
        kind: 'narration_audio',
        label: `Narration: ${story.title}`,
        status: 'ready',
        progress: 1,
        bytes: blob.size,
        error: null,
        updatedAt: nowIso(),
        refId: story.id,
      });
    }),
  );
}

export async function removeNarration(db: TinigDb, storyVersionId: string): Promise<void> {
  await db.transaction('rw', db.recordings, db.stories, db.downloads, async () => {
    await db.recordings.delete(narrationKey(storyVersionId));
    await db.stories.update(storyVersionId, { narration: null });
    await db.downloads.delete(narrationKey(storyVersionId));
  });
}
