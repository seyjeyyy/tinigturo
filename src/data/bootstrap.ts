import { STARTER_CONTENT_VERSION, STARTER_STORIES } from '../content/starterStories';
import { STARTER_VOCABULARY } from '../content/starterVocabulary';
import { guardStorage } from '../db/errors';
import { kvGet, kvSet, type TinigDb } from '../db/localDb';
import { nowIso } from '../lib/ids';

/** Ensures the bundled starter stories and vocabulary exist in this partition. */
export async function ensureBundledContent(db: TinigDb): Promise<void> {
  const installed = await kvGet<number>(db, 'starterContentVersion');
  if (installed === STARTER_CONTENT_VERSION) return;
  await guardStorage(() =>
    db.transaction('rw', db.stories, db.vocabulary, db.downloads, db.kv, async () => {
      await db.stories.bulkPut(STARTER_STORIES);
      await db.vocabulary.bulkPut(STARTER_VOCABULARY);
      await db.downloads.put({
        id: 'vocabulary:starter',
        kind: 'vocabulary',
        label: 'Starter word list (English and Filipino)',
        status: 'ready',
        progress: 1,
        bytes: new Blob([JSON.stringify(STARTER_VOCABULARY)]).size,
        error: null,
        updatedAt: nowIso(),
        refId: null,
      });
      await kvSet(db, 'starterContentVersion', STARTER_CONTENT_VERSION);
    }),
  );
}
