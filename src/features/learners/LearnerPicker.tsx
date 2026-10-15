import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { safeReturnPath } from '../../lib/paths';
import { UserPlus } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { AVATARS, type AvatarId } from '../../domain/types';
import { createLearner, validateLearnerName } from '../../data/learners';
import { Button } from '../../ui/Button';
import { Alert, EmptyState, PageHeader } from '../../ui/feedback';
import { Dialog } from '../../ui/Dialog';
import { SelectField, TextField } from '../../ui/fields';
import { StorageFullError } from '../../db/errors';

export function AvatarChooser({ value, onChange }: { value: AvatarId; onChange: (id: AvatarId) => void }) {
  return (
    <fieldset>
      <legend className="mb-2 font-semibold">Choose a picture</legend>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {AVATARS.map((a) => (
          <label key={a.id} className={`flex min-h-16 cursor-pointer flex-col items-center justify-center rounded-xl border-2 p-1 text-3xl has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-blue-brand ${value === a.id ? 'border-teal-brand bg-teal-tint' : 'border-line bg-white'}`}>
            <input type="radio" name="avatar" value={a.id} checked={value === a.id} onChange={() => onChange(a.id)} className="sr-only" />
            <span aria-hidden="true">{a.emoji}</span>
            <span className="text-xs font-medium">{a.label}{value === a.id ? ' ✓' : ''}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateLearnerDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { db, partition } = useApp();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<AvatarId>('owl');
  const [grade, setGrade] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validateLearnerName(name);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const learner = await createLearner(db, { displayName: name, avatar, gradeLevel: grade ? Number(grade) : null });
      setName('');
      onCreated(learner.id);
    } catch (e) {
      setError(e instanceof StorageFullError ? 'This device is out of storage space.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add a reader" size="lg">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField label="First name or nickname" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} error={error} maxLength={40} autoComplete="off" hint="Use a first name or nickname only." />
        <AvatarChooser value={avatar} onChange={setAvatar} />
        <SelectField label="Grade (optional)" value={grade} onChange={(e) => setGrade(e.target.value)}>
          <option value="">Not set</option>
          {[1, 2, 3, 4, 5, 6].map((g) => <option key={g} value={g}>Grade {g}</option>)}
        </SelectField>
        <p className="text-sm text-ink-soft">
          {partition === 'device'
            ? 'This reader will be saved on this device only.'
            : 'This reader will be linked to your account and synced when you are online.'}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Add reader</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function LearnerPicker() {
  const { learners, selectLearner, partition, auth, deviceSettings, useDevicePartition, setUseDevicePartition, cloud } = useApp();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath((location.state as { from?: unknown } | null)?.from);
  const shared = deviceSettings.deviceMode === 'shared_classroom';

  const choose = async (id: string) => {
    await selectLearner(id);
    navigate(returnTo ?? '/', { replace: Boolean(returnTo) });
  };

  return (
    <div>
      <PageHeader
        title="Who is reading today?"
        description={shared ? `Classroom device${deviceSettings.sharedClassName ? ` for ${deviceSettings.sharedClassName}` : ''}. Choose your picture.` : 'Choose your picture to start.'}
      />
      {learners.length === 0 ? (
        <EmptyState
          icon="🦉"
          title="No readers yet"
          action={!shared ? <Button icon={<UserPlus size={20} />} onClick={() => setCreating(true)}>Add a reader</Button> : undefined}
        >
          {shared ? 'Ask your teacher to set up the class list on this device.' : 'Add a reader to start practicing. You can read offline once the app is installed.'}
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4" aria-label="Readers">
          {learners.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => void choose(l.id)}
                className="flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-line bg-white p-3 text-center hover:border-teal-brand"
              >
                <span aria-hidden="true" className="text-5xl">{AVATARS.find((a) => a.id === l.avatar)?.emoji ?? '🦉'}</span>
                <span className="text-lg font-bold">{l.displayName}</span>
              </button>
            </li>
          ))}
          {!shared ? (
            <li>
              <button type="button" onClick={() => setCreating(true)} className="flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line p-3 font-semibold hover:border-teal-brand">
                <UserPlus size={36} aria-hidden="true" />
                Add a reader
              </button>
            </li>
          ) : null}
        </ul>
      )}

      <div className="mt-8 space-y-3 text-sm text-ink-soft">
        {cloud.status === 'configured' && auth.status === 'signed_in' ? (
          <Alert tone="info">
            {partition === 'device'
              ? 'You are viewing readers saved only on this device (not synced).'
              : `Readers for ${auth.email ?? 'your account'}.`}{' '}
            <button type="button" className="font-semibold underline" onClick={() => void setUseDevicePartition(!useDevicePartition)}>
              {partition === 'device' ? 'Show my account’s readers' : 'Show readers saved only on this device'}
            </button>
          </Alert>
        ) : null}
        <p><Link to="/account" className="font-semibold underline">Grown-ups: sign in, join a class, or open the teacher workspace</Link></p>
        <p><Link to="/install" className="font-semibold underline">Get the Tinig Turo app (Android download or install)</Link></p>
      </div>

      <CreateLearnerDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); void choose(id); }} />
    </div>
  );
}
