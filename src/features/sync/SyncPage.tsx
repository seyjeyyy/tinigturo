import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { resolveStoryConflict } from '../../sync/engine';
import type { OutboxOp } from '../../domain/types';
import { formatDateTime, formatRelative } from '../../lib/format';
import { Alert, Card, EmptyState, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';

const LABELS: Record<OutboxOp['type'], string> = {
  'learner.create': 'New reader',
  'session.submit': 'Reading',
  'session.review': 'Teacher review request',
  'audio.upload': 'Recording upload',
  'word.save': 'Saved word',
  'word.archive': 'Removed word',
  'word.practice': 'Word practice',
  'story.update': 'Story edit',
};

const STATUS: Record<OutboxOp['status'], { tone: 'neutral' | 'teal' | 'sun' | 'danger' | 'blue'; icon: string; text: string }> = {
  pending: { tone: 'neutral', icon: '⇡', text: 'Waiting' },
  syncing: { tone: 'blue', icon: '↻', text: 'Sending' },
  synced: { tone: 'teal', icon: '✓', text: 'Synced' },
  conflict: { tone: 'sun', icon: '⚠', text: 'Needs your decision' },
  failed: { tone: 'danger', icon: '!', text: 'Could not sync' },
};

export function SyncPage() {
  const { db, sync, online, partition, cloud, auth } = useApp();
  const ops = useLiveQuery(() => db.outbox.orderBy('createdAt').reverse().limit(200).toArray(), [db], []);

  if (partition === 'device') {
    return (
      <div>
        <PageHeader title="Sync" />
        <EmptyState icon="💾" title="Saved on this device only" action={cloud.status === 'configured' ? <ButtonLink to="/account">Sign in</ButtonLink> : undefined}>
          {cloud.status === 'configured'
            ? 'Readers created without an account are not synced. Sign in to create readers that sync with your account and teacher.'
            : 'Cloud sync is not set up for this copy of Tinig Turo, so everything is stored on this device.'}
        </EmptyState>
      </div>
    );
  }

  const { state, unsynced } = sync;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Sync"
        description={<>Last successful sync: <strong>{state.lastSuccessAt ? `${formatRelative(state.lastSuccessAt)} (${formatDateTime(state.lastSuccessAt)})` : 'never'}</strong></>}
        actions={<Button icon={<RefreshCw size={20} />} disabled={!online || state.phase === 'syncing'} busy={state.phase === 'syncing'} onClick={() => void sync.syncNow()}>{online ? 'Sync now' : 'Offline'}</Button>}
      />
      {!online ? <Alert tone="offline">You are offline. Everything is saved on this device and will sync when you reconnect.</Alert> : null}
      {state.phase === 'auth_required' ? (
        <Alert tone="warning" title="Sign in again to sync" action={<ButtonLink size="sm" to="/account/sign-in">Sign in</ButtonLink>}>
          Your sign-in for {auth.email ?? 'this account'} expired. Nothing has been lost.
        </Alert>
      ) : null}
      {state.message && state.phase !== 'auth_required' ? <Alert tone={state.phase === 'error' ? 'warning' : 'info'}>{state.message}</Alert> : null}

      <Card>
        <p>Waiting to sync: <strong>{unsynced.total - unsynced.failed - unsynced.conflicts}</strong> · Need attention: <strong>{unsynced.failed + unsynced.conflicts}</strong></p>
      </Card>

      {ops.length === 0 ? <EmptyState icon="✓" title="Nothing to sync" /> : (
        <Card>
          <ul className="divide-y divide-line">
            {ops.map((op) => {
              const s = STATUS[op.status];
              return (
                <li key={op.opId} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{LABELS[op.type]}</span>
                    <StatusBadge tone={s.tone} icon={s.icon}>{s.text}</StatusBadge>
                    <span className="text-sm text-ink-soft">{formatDateTime(op.createdAt)}{op.attempts ? ` · ${op.attempts} tries` : ''}</span>
                  </div>
                  {op.lastError && op.status !== 'synced' ? <p className="mt-1 text-sm text-ink-soft">{op.lastError}</p> : null}
                  {op.status === 'conflict' && op.type === 'story.update' ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <p className="w-full text-sm">Someone else changed this story after you started editing.</p>
                      <Button size="sm" variant="secondary" onClick={() => void resolveStoryConflict(db, op.opId, 'keep_server')}>Keep their version</Button>
                      <Button size="sm" onClick={() => void resolveStoryConflict(db, op.opId, 'overwrite').then(() => sync.syncNow())}>Replace with my version</Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
