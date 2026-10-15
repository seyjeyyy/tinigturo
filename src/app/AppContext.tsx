import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Session } from '@supabase/supabase-js';
import { cloudConfigState, type CloudConfigState } from '../backend/config';
import { getSupabase } from '../backend/supabaseClient';
import { SupabaseRemote } from '../backend/supabaseRemote';
import { fetchMyRoles } from '../backend/accountApi';
import { getDb, kvGet, kvSet, type PartitionId, type TinigDb } from '../db/localDb';
import {
  DEFAULT_DEVICE_SETTINGS, getPinRecord, metaGet, metaSet, rememberPartition, type DeviceSettings,
} from '../db/metaDb';
import { ensureBundledContent } from '../data/bootstrap';
import { listLearners } from '../data/learners';
import type { LearnerProfile } from '../domain/types';
import { INITIAL_SYNC_STATE, SyncEngine, type SyncState } from '../sync/engine';
import { unsyncedSummary, type UnsyncedSummary } from '../sync/outbox';
import { verifyPin } from '../lib/pin';

export interface PartitionSettings {
  /** The adult responsible allowed the browser's online speech service. Off by default. */
  allowCloudRecognition: boolean;
  /** Share recordings with teachers when the recording policy allows it. Off by default. */
  shareRecordings: boolean;
}

export const DEFAULT_PARTITION_SETTINGS: PartitionSettings = { allowCloudRecognition: false, shareRecordings: false };

export interface AuthState {
  status: 'loading' | 'signed_out' | 'signed_in' | 'not_configured';
  userId: string | null;
  email: string | null;
}

interface AppContextValue {
  cloud: CloudConfigState;
  auth: AuthState;
  roles: string[];
  isTeacher: boolean;
  partition: PartitionId;
  db: TinigDb;
  ready: boolean;
  online: boolean;
  learners: LearnerProfile[];
  learner: LearnerProfile | null;
  selectLearner: (id: string | null) => Promise<void>;
  settings: PartitionSettings;
  updateSettings: (patch: Partial<PartitionSettings>) => Promise<void>;
  deviceSettings: DeviceSettings;
  updateDeviceSettings: (patch: Partial<DeviceSettings>) => Promise<void>;
  useDevicePartition: boolean;
  setUseDevicePartition: (value: boolean) => Promise<void>;
  sync: {
    available: boolean;
    state: SyncState;
    unsynced: UnsyncedSummary;
    syncNow: () => Promise<void>;
  };
  activity: { recordingActive: boolean; setRecordingActive: (active: boolean) => void };
  teacherLock: { locked: boolean; hasPin: boolean; unlock: (pin: string) => Promise<boolean>; lock: () => void; refresh: () => Promise<void> };
  refreshRoles: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const EMPTY_LEARNERS: LearnerProfile[] = [];
const EMPTY_UNSYNCED: UnsyncedSummary = { total: 0, sessions: 0, recordings: 0, words: 0, other: 0, conflicts: 0, failed: 0 };

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function useAuth(): AuthState {
  const [auth, setAuth] = useState<AuthState>(() =>
    cloudConfigState.status === 'configured' ? { status: 'loading', userId: null, email: null } : { status: 'not_configured', userId: null, email: null },
  );
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    const apply = (session: Session | null) =>
      setAuth(session ? { status: 'signed_in', userId: session.user.id, email: session.user.email ?? null } : { status: 'signed_out', userId: null, email: null });
    // Works offline: the stored session identifies whose local data to open, even if
    // its token has expired. Fresh authorization is checked again before syncing.
    void supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => apply(session));
    return () => data.subscription.unsubscribe();
  }, []);
  return auth;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const online = useOnline();
  const [useDevicePartition, setUseDevicePartitionState] = useState(false);
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings>(DEFAULT_DEVICE_SETTINGS);
  const [roles, setRoles] = useState<string[]>([]);
  const [dbReady, setDbReady] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [teacherUnlocked, setTeacherUnlocked] = useState(() => sessionStorage.getItem('tinigturo-teacher-unlocked') === '1');
  const [hasPin, setHasPin] = useState(false);

  const partition: PartitionId = auth.status === 'signed_in' && auth.userId && !useDevicePartition ? `user:${auth.userId}` : 'device';
  const db = useMemo(() => getDb(partition), [partition]);

  useEffect(() => {
    void metaGet<DeviceSettings>('deviceSettings').then((s) => s && setDeviceSettings({ ...DEFAULT_DEVICE_SETTINGS, ...s }));
    void metaGet<boolean>('useDevicePartition').then((v) => setUseDevicePartitionState(Boolean(v)));
  }, []);

  useEffect(() => {
    if (auth.status === 'loading') return;
    let cancelled = false;
    setDbReady(false);
    void (async () => {
      try {
        await db.open();
        await ensureBundledContent(db);
        await rememberPartition({
          id: partition,
          kind: partition === 'device' ? 'device' : 'account',
          userId: partition === 'device' ? null : auth.userId,
          email: partition === 'device' ? null : auth.email,
        });
      } finally {
        if (!cancelled) setDbReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, partition, auth.status, auth.userId, auth.email]);

  // Roles: refreshed from the server when online, cached for offline display only.
  const refreshRoles = useCallback(async () => {
    if (auth.status !== 'signed_in' || !auth.userId) {
      setRoles([]);
      return;
    }
    const cacheKey = `roles:${auth.userId}`;
    const cached = await metaGet<string[]>(cacheKey);
    if (cached) setRoles(cached);
    if (!navigator.onLine) return;
    try {
      const fresh = await fetchMyRoles();
      setRoles(fresh);
      await metaSet(cacheKey, fresh);
    } catch {
      // keep cached roles; the server enforces access regardless
    }
  }, [auth.status, auth.userId]);

  useEffect(() => {
    void refreshRoles();
  }, [refreshRoles, online]);

  useEffect(() => {
    if (auth.userId) void getPinRecord(auth.userId).then((r) => setHasPin(Boolean(r)));
    else setHasPin(false);
  }, [auth.userId]);

  // `undefined` means "still loading", so screens never act on a not-yet-loaded reader.
  const learnersQuery = useLiveQuery(() => (dbReady ? listLearners(db) : undefined), [db, dbReady]);
  const activeLearnerQuery = useLiveQuery(
    async () => (dbReady ? ((await kvGet<string | null>(db, 'activeLearnerId')) ?? null) : undefined),
    [db, dbReady],
  );
  const ready = dbReady && learnersQuery !== undefined && activeLearnerQuery !== undefined;
  const learners = learnersQuery ?? EMPTY_LEARNERS;
  const learner = learners.find((l) => l.id === activeLearnerQuery) ?? null;

  const settings = useLiveQuery(
    async () => ({ ...DEFAULT_PARTITION_SETTINGS, ...((dbReady ? await kvGet<PartitionSettings>(db, 'settings') : undefined) ?? {}) }),
    [db, dbReady],
    DEFAULT_PARTITION_SETTINGS,
  );

  const selectLearner = useCallback(async (id: string | null) => {
    await kvSet(db, 'activeLearnerId', id);
  }, [db]);

  const updateSettings = useCallback(async (patch: Partial<PartitionSettings>) => {
    const current = (await kvGet<PartitionSettings>(db, 'settings')) ?? DEFAULT_PARTITION_SETTINGS;
    await kvSet(db, 'settings', { ...current, ...patch });
  }, [db]);

  const updateDeviceSettings = useCallback(async (patch: Partial<DeviceSettings>) => {
    setDeviceSettings((current) => {
      const next = { ...current, ...patch };
      void metaSet('deviceSettings', next);
      return next;
    });
  }, []);

  const setUseDevicePartition = useCallback(async (value: boolean) => {
    await metaSet('useDevicePartition', value);
    setUseDevicePartitionState(value);
  }, []);

  // ---- synchronization ---------------------------------------------------
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const engine = useMemo(() => {
    const supabase = getSupabase();
    if (!supabase || partition === 'device' || !auth.userId) return null;
    return new SyncEngine({
      db,
      remote: new SupabaseRemote(supabase),
      expectedUserId: auth.userId,
      shouldUploadAudio: () => settingsRef.current.shareRecordings,
    });
  }, [db, partition, auth.userId]);

  const syncState = useLiveQuery(async () => (await kvGet<SyncState>(db, 'syncState')) ?? INITIAL_SYNC_STATE, [db], INITIAL_SYNC_STATE);
  const unsynced = useLiveQuery(() => (partition === 'device' ? EMPTY_UNSYNCED : unsyncedSummary(db)), [db, partition], EMPTY_UNSYNCED);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSync = useCallback(async (manual: boolean) => {
    if (!engine) return;
    await engine.sync({ manual });
    if (retryTimer.current) clearTimeout(retryTimer.current);
    const due = await engine.nextDueAt();
    if (due !== null) {
      retryTimer.current = setTimeout(() => void runSync(false), Math.max(1_000, due - Date.now()));
    }
  }, [engine]);

  // Foreground triggers: launch, reconnect, returning to the app, and new work queued.
  useEffect(() => {
    if (!engine || !ready) return;
    void runSync(false);
    const onOnline = () => void runSync(false);
    const onVisible = () => document.visibilityState === 'visible' && void runSync(false);
    const onSwMessage = (event: MessageEvent) => event.data?.type === 'tinigturo-sync' && void runSync(false);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [engine, ready, runSync]);

  const pendingCount = unsynced.total - unsynced.failed - unsynced.conflicts;
  useEffect(() => {
    if (!engine || pendingCount <= 0) return;
    if (navigator.onLine) {
      const timer = setTimeout(() => void runSync(false), 1500);
      return () => clearTimeout(timer);
    }
    // Optional enhancement: ask the browser to wake us when connectivity returns.
    void navigator.serviceWorker?.ready
      .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register('tinigturo-sync'))
      .catch(() => undefined);
  }, [engine, pendingCount, runSync]);

  // ---- teacher quick-access lock -----------------------------------------
  const unlock = useCallback(async (pin: string) => {
    if (!auth.userId) return false;
    const record = await getPinRecord(auth.userId);
    if (!record) return false;
    const ok = await verifyPin(pin, record);
    if (ok) {
      setTeacherUnlocked(true);
      sessionStorage.setItem('tinigturo-teacher-unlocked', '1');
    }
    return ok;
  }, [auth.userId]);

  const lock = useCallback(() => {
    setTeacherUnlocked(false);
    sessionStorage.removeItem('tinigturo-teacher-unlocked');
  }, []);

  const refreshPin = useCallback(async () => {
    if (auth.userId) setHasPin(Boolean(await getPinRecord(auth.userId)));
  }, [auth.userId]);

  const value: AppContextValue = {
    cloud: cloudConfigState,
    auth,
    roles,
    isTeacher: roles.includes('teacher') || roles.includes('admin') || roles.includes('content_editor'),
    partition,
    db,
    ready,
    online,
    learners,
    learner,
    selectLearner,
    settings,
    updateSettings,
    deviceSettings,
    updateDeviceSettings,
    useDevicePartition,
    setUseDevicePartition,
    sync: { available: engine !== null, state: syncState, unsynced, syncNow: () => runSync(true) },
    activity: { recordingActive, setRecordingActive },
    teacherLock: { locked: hasPin && !teacherUnlocked, hasPin, unlock, lock, refresh: refreshPin },
    refreshRoles,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
