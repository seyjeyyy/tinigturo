import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link2 } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { getDb } from '../../db/localDb';
import { StorageFullError } from '../../db/errors';
import { verifySignedInUser } from '../../backend/accountApi';
import { linkDeviceLearners, listLinkCandidates, pendingLinkJournal, resumeLinking, type LinkCandidate } from '../../data/linking';
import { avatarById } from '../../domain/types';
import { Alert, Card } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';

function describe(c: LinkCandidate): string {
  const parts = [
    `${c.savedReadings} ${c.savedReadings === 1 ? 'reading' : 'readings'}`,
    c.unfinishedReadings ? `${c.unfinishedReadings} unfinished` : null,
    `${c.recordings} ${c.recordings === 1 ? 'recording' : 'recordings'}`,
    `${c.words} saved ${c.words === 1 ? 'word' : 'words'}`,
    c.badges ? `${c.badges} ${c.badges === 1 ? 'badge' : 'badges'}` : null,
  ];
  return parts.filter(Boolean).join(', ');
}

/**
 * Lets the adult add readers saved only on this device to the signed-in account. It
 * shows exactly which readers and records move, asks the adult to confirm the
 * destination account, checks with the server that this account is signed in, and
 * never runs on its own.
 */
export function LinkReadersCard() {
  const { auth, online, sync, setUseDevicePartition, selectLearner } = useApp();
  const device = getDb('device');
  const userId = auth.userId!;
  const candidates = useLiveQuery(() => listLinkCandidates(device), [device]);
  const journal = useLiveQuery(() => pendingLinkJournal(userId), [userId]);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  if (!candidates || journal === undefined) return null;
  if (!candidates.length && !journal && !message) return null;
  const selected = chosen ?? new Set(candidates.map((c) => c.learner.id));
  const picked = candidates.filter((c) => selected.has(c.learner.id));
  const target = getDb(`user:${userId}`);

  const finish = async (run: () => Promise<{ linked: string[]; alreadyLinked: string[] } | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      // The account must be confirmed by the server, not only by this device's memory.
      const verified = await verifySignedInUser();
      if (!verified || verified.userId !== userId) {
        setMessage({ tone: 'error', text: 'Your sign-in could not be confirmed. Sign in again, then add the readers.' });
        return;
      }
      const report = await run();
      const count = (report?.linked.length ?? 0) + (report?.alreadyLinked.length ?? 0);
      await setUseDevicePartition(false);
      if (report?.linked[0] ?? report?.alreadyLinked[0]) await selectLearner(report.linked[0] ?? report.alreadyLinked[0]);
      setMessage({ tone: 'success', text: `${count} ${count === 1 ? 'reader was' : 'readers were'} added to ${auth.email ?? 'your account'}. Their work will sync now.` });
      setConfirmOpen(false);
      void sync.syncNow();
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof StorageFullError
          ? 'This device is out of space, so not every reader could be added. Nothing was lost. Free some space, then press “Finish adding readers”.'
          : (error as Error).message || 'Adding the readers stopped. Nothing was lost; press “Finish adding readers” to continue.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="mb-1 flex items-center gap-2 text-lg font-bold"><Link2 size={20} aria-hidden="true" />Readers saved only on this device</h2>
      {message ? <Alert tone={message.tone} className="mb-3">{message.text}</Alert> : null}
      {journal ? (
        <Alert tone="warning" title="Adding readers to your account was interrupted" className="mb-3">
          Nothing was lost. Finish it to move the remaining readers.
          <div className="mt-2">
            <Button size="sm" busy={busy} disabled={!online} onClick={() => void finish(() => resumeLinking({ source: device, target, userId }))}>Finish adding readers</Button>
          </div>
        </Alert>
      ) : null}
      {candidates.length ? (
        <>
          <p className="mb-3 text-sm text-ink-soft">
            These readers are not in any account, so no teacher can see their work and it is not backed up. You can add them to
            <strong> {auth.email}</strong>. Nothing moves until you confirm.
          </p>
          <ul className="mb-3 space-y-2">
            {candidates.map((c) => (
              <li key={c.learner.id}>
                <label className="flex items-start gap-3 rounded-xl border border-line p-2">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5"
                    checked={selected.has(c.learner.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(c.learner.id);
                      else next.delete(c.learner.id);
                      setChosen(next);
                    }}
                  />
                  <span>
                    <span className="font-semibold">{avatarById(c.learner.avatar).emoji} {c.learner.displayName}</span>
                    <span className="block text-sm text-ink-soft">{describe(c)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {!online ? <Alert tone="offline" className="mb-3">Adding readers needs the internet, so the account can be confirmed.</Alert> : null}
          <Button icon={<Link2 size={20} />} disabled={!picked.length || !online || Boolean(journal)} onClick={() => { setConfirmed(false); setConfirmOpen(true); }}>
            Add to my account…
          </Button>
        </>
      ) : null}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`Add ${picked.length} ${picked.length === 1 ? 'reader' : 'readers'} to ${auth.email ?? 'this account'}?`}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              busy={busy}
              disabled={!confirmed || !online}
              onClick={() => void finish(() => linkDeviceLearners({ source: device, target, userId, email: auth.email, learnerIds: picked.map((c) => c.learner.id) }))}
            >
              Add to {auth.email ?? 'my account'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <ul className="list-disc space-y-1 pl-5">
            {picked.map((c) => <li key={c.learner.id}><strong>{c.learner.displayName}</strong>: {describe(c)}</li>)}
          </ul>
          <p>What happens:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>The readers move into this account on this device and are synced to it. They stop appearing under “readers saved only on this device”.</li>
            <li>Their readings, saved words and practice are sent to the account. Badges are checked again by the server.</li>
            <li>Recordings stay on this device. They are shared with a teacher only if you turn on recording sharing and consent for the reader.</li>
            <li>A reader can belong to one account only. If it is already in someone else’s account, it is refused and kept on this device.</li>
          </ul>
          <label className="flex items-start gap-3 rounded-xl border-2 border-sun bg-sun-tint p-3">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I am the parent or guardian of {picked.length === 1 ? 'this child' : 'these children'}, or their teacher, and I want their practice kept in the account <strong>{auth.email}</strong>.</span>
          </label>
        </div>
      </Dialog>
    </Card>
  );
}
