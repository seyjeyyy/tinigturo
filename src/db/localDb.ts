import Dexie, { type Table } from 'dexie';
import type {
  AudioChunk,
  DownloadRecord,
  KeyValue,
  LearnerProfile,
  LearnerWord,
  LocalAssignment,
  LocalRecording,
  LocalReward,
  OutboxOp,
  ReadingSessionRecord,
  StoryDraftRecord,
  StoryVersionRecord,
  VocabularyEntry,
} from '../domain/types';

/**
 * Local data is partitioned by identity: each signed-in account gets its own
 * IndexedDB database, and learners created without an account live in the "device"
 * partition. Signing out can therefore remove one identity's private data without
 * touching another's.
 */
export type PartitionId = 'device' | `user:${string}`;

export function partitionDbName(partition: PartitionId): string {
  return `tinigturo:${partition}`;
}

export class TinigDb extends Dexie {
  learners!: Table<LearnerProfile, string>;
  stories!: Table<StoryVersionRecord, string>;
  downloads!: Table<DownloadRecord, string>;
  sessions!: Table<ReadingSessionRecord, string>;
  audioChunks!: Table<AudioChunk, [string, number]>;
  recordings!: Table<LocalRecording, string>;
  vocabulary!: Table<VocabularyEntry, string>;
  learnerWords!: Table<LearnerWord, string>;
  rewards!: Table<LocalReward, string>;
  outbox!: Table<OutboxOp, string>;
  kv!: Table<KeyValue, string>;
  assignments!: Table<LocalAssignment, string>;
  storyDrafts!: Table<StoryDraftRecord, string>;

  constructor(readonly partition: PartitionId) {
    super(partitionDbName(partition));
    this.version(1).stores({
      learners: 'id, archivedAt',
      stories: 'id, storyId, language, gradeLevel, topic, source',
      downloads: 'id, kind, status, refId',
      sessions: 'id, learnerId, [learnerId+startedAt], storyVersionId, status, sync',
      audioChunks: '[sessionId+seq], sessionId',
      recordings: 'sessionId',
      vocabulary: 'id, [language+normalized]',
      learnerWords: 'id, learnerId, [learnerId+savedAt], sync',
      rewards: 'id, learnerId, sessionId, status',
      outbox: 'opId, status, createdAt, entityId, type, learnerId',
      kv: 'key',
      assignments: 'id, classId, storyVersionId',
      storyDrafts: 'storyId',
    });
  }
}

const open = new Map<PartitionId, TinigDb>();

export function getDb(partition: PartitionId): TinigDb {
  let db = open.get(partition);
  if (!db) {
    db = new TinigDb(partition);
    open.set(partition, db);
  }
  return db;
}

/** Permanently deletes one identity's local database. */
export async function deletePartition(partition: PartitionId): Promise<void> {
  const db = open.get(partition);
  if (db) {
    db.close();
    open.delete(partition);
  }
  await Dexie.delete(partitionDbName(partition));
}

export async function kvGet<T>(db: TinigDb, key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}

export async function kvSet(db: TinigDb, key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}
