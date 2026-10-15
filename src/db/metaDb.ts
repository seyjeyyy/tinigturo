import Dexie, { type Table } from 'dexie';
import type { PartitionId } from './localDb';
import type { PinRecord } from '../lib/pin';

/**
 * Device-level metadata shared by all partitions: which identities have local data,
 * which partition was last used, and per-account teacher PINs. Holds no learner data.
 */
export interface PartitionInfo {
  id: PartitionId;
  kind: 'device' | 'account';
  userId: string | null;
  email: string | null;
  lastUsedAt: string;
}

export interface DeviceSettings {
  /** Personal device (one family/learner) or a trusted classroom device run by a teacher. */
  deviceMode: 'personal' | 'shared_classroom';
  sharedClassId: string | null;
  sharedClassName: string | null;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { deviceMode: 'personal', sharedClassId: null, sharedClassName: null };

class MetaDb extends Dexie {
  partitions!: Table<PartitionInfo, string>;
  kv!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super('tinigturo-meta');
    this.version(1).stores({ partitions: 'id, userId, lastUsedAt', kv: 'key' });
  }
}

export const metaDb = new MetaDb();

export async function metaGet<T>(key: string): Promise<T | undefined> {
  return (await metaDb.kv.get(key))?.value as T | undefined;
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  await metaDb.kv.put({ key, value });
}

export async function metaDelete(key: string): Promise<void> {
  await metaDb.kv.delete(key);
}

export async function rememberPartition(info: Omit<PartitionInfo, 'lastUsedAt'>): Promise<void> {
  await metaDb.partitions.put({ ...info, lastUsedAt: new Date().toISOString() });
}

export async function getPinRecord(userId: string): Promise<PinRecord | undefined> {
  return metaGet<PinRecord>(`teacherPin:${userId}`);
}

export async function setPinRecord(userId: string, record: PinRecord | null): Promise<void> {
  if (record) await metaSet(`teacherPin:${userId}`, record);
  else await metaDelete(`teacherPin:${userId}`);
}
