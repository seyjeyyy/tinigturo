import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2, CloudOff, KeyRound, Loader2, UploadCloud, WifiOff } from 'lucide-react';
import { useApp } from './AppContext';
import { formatRelative } from '../lib/format';

/** Connectivity and sync status, always as icon + words. */
export function SyncPill() {
  const { online, sync, partition } = useApp();
  if (partition === 'device') {
    return (
      <Link to="/sync" className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-white px-3 text-sm font-medium">
        <CloudOff size={16} aria-hidden="true" />
        <span>Saved on this device</span>
      </Link>
    );
  }
  const { state, unsynced } = sync;
  let icon = <CheckCircle2 size={16} aria-hidden="true" />;
  let text = 'All synced';
  if (!online) {
    icon = <WifiOff size={16} aria-hidden="true" />;
    text = unsynced.total ? `Offline · ${unsynced.total} waiting` : 'Offline';
  } else if (state.phase === 'syncing') {
    icon = <Loader2 size={16} className="animate-spin" aria-hidden="true" />;
    text = 'Syncing…';
  } else if (state.phase === 'auth_required') {
    icon = <KeyRound size={16} aria-hidden="true" />;
    text = 'Sign in to sync';
  } else if (unsynced.conflicts || unsynced.failed) {
    icon = <AlertTriangle size={16} aria-hidden="true" />;
    text = 'Needs attention';
  } else if (unsynced.total) {
    icon = <UploadCloud size={16} aria-hidden="true" />;
    text = `${unsynced.total} waiting`;
  }
  return (
    <Link
      to="/sync"
      className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-white px-3 text-sm font-medium"
      aria-label={`Sync status: ${text}. Last synced ${state.lastSuccessAt ? formatRelative(state.lastSuccessAt) : 'never'}.`}
    >
      {icon}
      <span>{text}</span>
    </Link>
  );
}

export function OfflineNotice() {
  const { online } = useApp();
  if (online) return null;
  return (
    <div role="status" className="border-b border-line bg-white px-4 py-1.5 text-center text-sm">
      <WifiOff size={14} className="mr-1 inline" aria-hidden="true" />
      You are offline. Reading, recording and saved words still work. Signing in, joining a class, downloading and syncing need the internet.
    </div>
  );
}
