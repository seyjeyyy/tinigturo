import type { LearnerWord, LocalReward, VocabularyEntry } from '../domain/types';
import { guardStorage } from '../db/errors';
import type { TinigDb } from '../db/localDb';
import { nowIso } from '../lib/ids';
import { evaluateWordAwards, rewardId } from '../rewards/rules';
import { newOp } from '../sync/outbox';
import type { LanguageCode } from '../text/language';
import { normalizeWord } from '../text/normalize';
import { partitionSyncs, pendingLearnerOp } from './learners';

export function learnerWordId(learnerId: string, language: LanguageCode, normalized: string): string {
  return `${learnerId}|${language}|${normalized}`;
}

/** Simple English inflection fallbacks for dictionary lookup ("puddles" -> "puddle"). */
function lookupCandidates(normalized: string, language: LanguageCode): string[] {
  const out = [normalized];
  if (language === 'en') {
    if (normalized.endsWith('ies')) out.push(normalized.slice(0, -3) + 'y');
    if (normalized.endsWith('es')) out.push(normalized.slice(0, -2));
    if (normalized.endsWith('s')) out.push(normalized.slice(0, -1));
    if (normalized.endsWith('ed')) out.push(normalized.slice(0, -2), normalized.slice(0, -1));
    if (normalized.endsWith('ing')) out.push(normalized.slice(0, -3), normalized.slice(0, -3) + 'e');
  }
  return out;
}

export async function lookupVocabulary(db: TinigDb, language: LanguageCode, word: string): Promise<VocabularyEntry | null> {
  const normalized = normalizeWord(word, language);
  for (const candidate of lookupCandidates(normalized, language)) {
    const entry = await db.vocabulary.where('[language+normalized]').equals([language, candidate]).first();
    if (entry) return entry;
  }
  return null;
}

export async function listLearnerWords(db: TinigDb, learnerId: string): Promise<LearnerWord[]> {
  const words = await db.learnerWords.where('learnerId').equals(learnerId).filter((w) => !w.archivedAt).toArray();
  return words.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function saveWord(
  db: TinigDb,
  input: { learnerId: string; language: LanguageCode; word: string; vocabularyEntryId: string | null; storyVersionId: string | null },
): Promise<{ word: LearnerWord; awards: LocalReward[] }> {
  const normalized = normalizeWord(input.word, input.language);
  if (!normalized) throw new Error('That is not a word we can save.');
  const id = learnerWordId(input.learnerId, input.language, normalized);
  const syncs = partitionSyncs(db);
  const learnerOp = syncs ? await pendingLearnerOp(db, input.learnerId) : null;

  return guardStorage(() =>
    db.transaction('rw', db.learnerWords, db.outbox, db.rewards, async () => {
      const existing = await db.learnerWords.get(id);
      const savedAt = nowIso();
      const word: LearnerWord = {
        id,
        learnerId: input.learnerId,
        language: input.language,
        word: existing?.word ?? input.word,
        normalized,
        vocabularyEntryId: input.vocabularyEntryId ?? existing?.vocabularyEntryId ?? null,
        storyVersionId: existing?.storyVersionId ?? input.storyVersionId,
        savedAt: existing && !existing.archivedAt ? existing.savedAt : savedAt,
        practiceCount: existing?.practiceCount ?? 0,
        lastPracticedAt: existing?.lastPracticedAt ?? null,
        archivedAt: null,
        sync: syncs ? 'pending' : 'local_only',
      };
      await db.learnerWords.put(word);
      if (syncs && (!existing || existing.archivedAt)) {
        await db.outbox.add(newOp('word.save', id, input.learnerId, {
          learnerId: input.learnerId, language: input.language, word: word.word, normalized,
          vocabularyEntryId: word.vocabularyEntryId, storyVersionId: word.storyVersionId, savedAt: word.savedAt,
        }, learnerOp ? [learnerOp] : []));
      }
      const count = await db.learnerWords.where('learnerId').equals(input.learnerId).filter((w) => !w.archivedAt).count();
      const awards: LocalReward[] = [];
      for (const candidate of evaluateWordAwards(count)) {
        const rid = rewardId(input.learnerId, candidate.badgeCode, candidate.sourceKey);
        if (await db.rewards.get(rid)) continue;
        const reward: LocalReward = {
          id: rid, learnerId: input.learnerId, badgeCode: candidate.badgeCode, sourceKey: candidate.sourceKey,
          sessionId: null, awardedAt: nowIso(), status: 'pending',
        };
        await db.rewards.add(reward);
        awards.push(reward);
      }
      return { word, awards };
    }),
  );
}

/** Removes a word from My Words using a tombstone, so the removal synchronizes. */
export async function removeWord(db: TinigDb, wordId: string): Promise<void> {
  await guardStorage(() =>
    db.transaction('rw', db.learnerWords, db.outbox, async () => {
      const word = await db.learnerWords.get(wordId);
      if (!word || word.archivedAt) return;
      const archivedAt = nowIso();
      await db.learnerWords.update(wordId, { archivedAt });
      if (partitionSyncs(db)) {
        await db.outbox.add(newOp('word.archive', wordId, word.learnerId, {
          learnerId: word.learnerId, language: word.language, normalized: word.normalized, archivedAt,
        }));
      }
    }),
  );
}

export async function recordPractice(db: TinigDb, wordId: string): Promise<void> {
  await guardStorage(() =>
    db.transaction('rw', db.learnerWords, db.outbox, async () => {
      const word = await db.learnerWords.get(wordId);
      if (!word || word.archivedAt) return;
      const practicedAt = nowIso();
      await db.learnerWords.update(wordId, { practiceCount: word.practiceCount + 1, lastPracticedAt: practicedAt });
      if (partitionSyncs(db)) {
        await db.outbox.add(newOp('word.practice', wordId, word.learnerId, {
          learnerId: word.learnerId, language: word.language, normalized: word.normalized, practicedAt,
        }));
      }
    }),
  );
}
