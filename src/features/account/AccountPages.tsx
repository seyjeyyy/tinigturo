import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { GraduationCap, KeyRound, LogIn, LogOut, School, UserPlus } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import {
  requestEnrollment, requestPasswordReset, resendConfirmation, setAudioConsent, signIn, signOut, signUp, updatePassword, type AccountType,
} from '../../backend/accountApi';
import { deletePartition } from '../../db/localDb';
import { unsyncedSummary, type UnsyncedSummary } from '../../sync/outbox';
import { Alert, Card, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';
import { SelectField, TextField, Toggle } from '../../ui/fields';
import { Dialog } from '../../ui/Dialog';
import { avatarById } from '../../domain/types';
import { fetchAccessibleLearners } from '../../backend/accountApi';
import { LinkReadersCard } from './LinkReaders';

function NeedsInternet({ what }: { what: string }) {
  const { online } = useApp();
  if (online) return null;
  return <Alert tone="offline" className="mb-4">{what} needs an internet connection. Connect and try again.</Alert>;
}

function friendlyAuthError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (/Invalid login credentials/i.test(message)) return 'The email or password is not right.';
  if (/Email not confirmed/i.test(message)) return 'Please confirm your email first. Check your inbox for the link.';
  if (/Failed to fetch|NetworkError/i.test(message)) return 'Could not reach the server. Check your internet connection.';
  if (/Password should be/i.test(message)) return message;
  return message;
}

export function CloudNotConfigured() {
  const { cloud } = useApp();
  return (
    <Card>
      <h2 className="mb-2 text-lg font-bold">Accounts and sync are not set up</h2>
      {cloud.status === 'unsafe' ? (
        <Alert tone="error" title="Unsafe configuration">{cloud.reason}</Alert>
      ) : (
        <p>
          This copy of Tinig Turo works fully offline on this device. To enable accounts, classes and sync, the person hosting it must set
          {cloud.status === 'missing' ? <> <code>{cloud.missing.join(', ')}</code></> : null} (see the setup guide).
        </p>
      )}
    </Card>
  );
}

export function AccountPage() {
  const { cloud, auth, isTeacher, roles } = useApp();
  const [signOutOpen, setSignOutOpen] = useState(false);
  return (
    <div className="space-y-5">
      <PageHeader title="Grown-ups" description="Accounts, classes and the teacher workspace." />
      {cloud.status !== 'configured' ? <CloudNotConfigured /> : auth.status === 'signed_in' ? (
        <>
          <Card>
            <p className="text-lg">Signed in as <strong>{auth.email}</strong></p>
            <p className="mt-1 flex flex-wrap gap-2">{roles.length ? roles.map((r) => <StatusBadge key={r} tone="teal" icon="✓">{r.replace('_', ' ')}</StatusBadge>) : <StatusBadge icon="👪">Parent or guardian</StatusBadge>}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {isTeacher ? <ButtonLink to="/teacher" icon={<GraduationCap size={20} />}>Open teacher workspace</ButtonLink> : null}
              <ButtonLink variant="secondary" to="/join" icon={<School size={20} />}>Join a class</ButtonLink>
              <ButtonLink variant="secondary" to="/account/update-password" icon={<KeyRound size={20} />}>Change password</ButtonLink>
              <Button variant="ghost" icon={<LogOut size={20} />} onClick={() => setSignOutOpen(true)}>Sign out</Button>
            </div>
          </Card>
          <LinkReadersCard />
          <ConsentCard />
        </>
      ) : (
        <Card>
          <p className="mb-3">Sign in to sync readers between devices, join a class, or use the teacher workspace. Readers on this device keep working without an account.</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink to="/account/sign-in" icon={<LogIn size={20} />}>Sign in</ButtonLink>
            <ButtonLink variant="secondary" to="/account/sign-up" icon={<UserPlus size={20} />}>Create an account</ButtonLink>
          </div>
        </Card>
      )}
      <Card>
        <h2 className="mb-2 text-lg font-bold">Works offline</h2>
        <p>Opening the installed app, choosing a reader, reading downloaded stories, recording, seeing saved progress and words.</p>
        <h2 className="mb-2 mt-3 text-lg font-bold">Needs the internet</h2>
        <p>Signing in for the first time, creating an account, password recovery, joining a class, downloading new stories or speech packs, and syncing.</p>
      </Card>
      <SignOutDialog open={signOutOpen} onClose={() => setSignOutOpen(false)} />
    </div>
  );
}

function ConsentCard() {
  const { online, partition } = useApp();
  const [learners, setLearners] = useState<{ id: string; display_name: string; avatar: string; audio_sharing_consent: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!online || partition === 'device') return;
    fetchAccessibleLearners().then(setLearners, () => setError('Could not load readers.'));
  }, [online, partition]);
  if (!online) return null;
  return (
    <Card>
      <h2 className="mb-1 text-lg font-bold">Recording consent</h2>
      <p className="mb-3 text-sm text-ink-soft">Allow a reader’s recordings to be shared privately with their teachers. Recordings are deleted after the class retention period. You can turn this off at any time.</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {learners?.length === 0 ? <p className="text-ink-soft">No synced readers yet.</p> : null}
      <div className="space-y-3">
        {learners?.map((l) => (
          <Toggle
            key={l.id}
            label={`${avatarById(l.avatar).emoji} ${l.display_name}`}
            checked={l.audio_sharing_consent}
            onChange={async (v) => {
              try {
                await setAudioConsent(l.id, v);
                setLearners((rows) => rows?.map((r) => (r.id === l.id ? { ...r, audio_sharing_consent: v } : r)) ?? null);
              } catch {
                setError('Only a guardian who created this reader can change consent.');
              }
            }}
          />
        ))}
      </div>
    </Card>
  );
}

export function SignOutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { db, partition, online, sync, teacherLock } = useApp();
  const [summary, setSummary] = useState<UnsyncedSummary | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    if (open) void unsyncedSummary(db).then(setSummary);
  }, [open, db, sync.unsynced.total]);

  const leave = async (removeData: boolean) => {
    setBusy(true);
    try {
      teacherLock.lock();
      await signOut();
      if (removeData && partition !== 'device') await deletePartition(partition);
      navigate('/');
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const unsynced = summary?.total ?? 0;
  return (
    <Dialog open={open} onClose={onClose} title="Sign out?" size="lg">
      <div className="space-y-4">
        {unsynced > 0 ? (
          <Alert tone="warning" title={`${unsynced} ${unsynced === 1 ? 'item has' : 'items have'} not been synced yet`}>
            {summary!.sessions} readings, {summary!.recordings} recordings, {summary!.words} word changes, {summary!.other} other.
            {online ? ' Sync now to keep them safe on the server.' : ' You are offline, so they cannot be synced right now.'}
          </Alert>
        ) : (
          <Alert tone="success">Everything is synced.</Alert>
        )}
        {unsynced > 0 && online ? <Button onClick={() => void sync.syncNow()}>Sync now</Button> : null}
        <div className="rounded-xl border border-line p-3">
          <p className="font-semibold">Sign out and keep data on this device</p>
          <p className="text-sm text-ink-soft">Readers, readings and unsynced work stay here, locked to this account. They sync after you sign in again.</p>
          <Button className="mt-2" variant="secondary" busy={busy} onClick={() => void leave(false)}>Sign out, keep data</Button>
        </div>
        <div className="rounded-xl border border-danger/40 p-3">
          <p className="font-semibold">Sign out and remove this account’s data from this device</p>
          <p className="text-sm text-ink-soft">Use this on a device you are giving back or sharing. Readers saved only on this device (without an account) are not affected.</p>
          {unsynced > 0 ? (
            <TextField label={`Type DELETE to remove ${unsynced} unsynced ${unsynced === 1 ? 'item' : 'items'} permanently`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          ) : null}
          <Button className="mt-2" variant="danger" busy={busy} disabled={unsynced > 0 && confirmText !== 'DELETE'} onClick={() => void leave(true)}>Sign out and remove data</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Lets someone whose confirmation link failed ask for a new one. */
function ResendConfirmation({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  if (state === 'sent') {
    return <Alert tone="success">A new confirmation email was sent to {email}. Open the newest email and click its link once. Earlier links no longer work.</Alert>;
  }
  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        busy={state === 'sending'}
        disabled={!email.includes('@')}
        onClick={async () => {
          setState('sending');
          try {
            await resendConfirmation(email.trim());
            setState('sent');
          } catch (e) {
            setState('error');
            setMessage(/rate|security purposes|seconds/i.test((e as Error).message)
              ? 'Please wait a minute before asking for another email.'
              : friendlyAuthError(e));
          }
        }}
      >
        Send a new confirmation email
      </Button>
      {state === 'error' && message ? <Alert tone="error">{message}</Alert> : null}
    </div>
  );
}

export function SignInPage() {
  const { cloud, refreshRoles } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  if (cloud.status !== 'configured') return <CloudNotConfigured />;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setUnconfirmed(false);
    try {
      await signIn(email.trim(), password);
      await refreshRoles();
      navigate('/account');
    } catch (e) {
      setError(friendlyAuthError(e));
      setUnconfirmed(/Email not confirmed/i.test((e as Error)?.message ?? ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Sign in" />
      <NeedsInternet what="Signing in" />
      <form onSubmit={submit} className="space-y-4">
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error ? <Alert tone="error">{error}</Alert> : null}
        {unconfirmed ? <ResendConfirmation email={email} /> : null}
        <Button type="submit" size="lg" busy={busy} className="w-full">Sign in</Button>
      </form>
      <p className="mt-4 flex flex-wrap justify-between gap-2">
        <Link to="/account/reset" className="underline">Forgot your password?</Link>
        <Link to="/account/sign-up" className="underline">Create an account</Link>
      </p>
    </div>
  );
}

export function SignUpPage() {
  const { cloud } = useApp();
  const [form, setForm] = useState({ email: '', password: '', displayName: '', accountType: 'guardian' as AccountType });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (cloud.status !== 'configured') return <CloudNotConfigured />;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (form.password.length < 8) return setError('Use at least 8 characters for the password.');
    setBusy(true);
    setError(null);
    try {
      const { needsConfirmation } = await signUp(form);
      setDone(needsConfirmation
        ? 'Check your email and click the link once to finish creating your account. If you ask for another email, only the newest link works.'
        : 'Your account is ready.');
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Create an account" description="For parents, guardians and teachers. Children do not need their own account." />
      <NeedsInternet what="Creating an account" />
      {done ? <Alert tone="success" action={<ButtonLink size="sm" to="/account/sign-in">Sign in</ButtonLink>}>{done}</Alert> : (
        <form onSubmit={submit} className="space-y-4">
          <TextField label="Your name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoComplete="name" maxLength={80} />
          <TextField label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <TextField label="Password" type="password" autoComplete="new-password" hint="At least 8 characters." value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          <SelectField label="I am a…" value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value as AccountType })}
            hint="Teacher accounts can create classes and stories. Your school administrator may need to approve the teacher role.">
            <option value="guardian">Parent or guardian</option>
            <option value="teacher">Teacher</option>
          </SelectField>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" size="lg" busy={busy} className="w-full">Create account</Button>
        </form>
      )}
    </div>
  );
}

export function ResetPasswordPage() {
  const { cloud } = useApp();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (cloud.status !== 'configured') return <CloudNotConfigured />;
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Reset your password" />
      <NeedsInternet what="Password recovery" />
      {sent ? <Alert tone="success">If an account exists for {email}, we sent a link to set a new password.</Alert> : (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await requestPasswordReset(email.trim());
            setSent(true);
          } catch (err) {
            setError(friendlyAuthError(err));
          }
        }}>
          <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" size="lg" className="w-full">Send reset link</Button>
        </form>
      )}
    </div>
  );
}

export function UpdatePasswordPage() {
  const { auth } = useApp();
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  if (auth.status !== 'signed_in') return <Alert tone="info">Open the link from your email to set a new password, or sign in first.</Alert>;
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Set a new password" />
      <NeedsInternet what="Changing your password" />
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        if (password.length < 8) return setMessage({ tone: 'error', text: 'Use at least 8 characters.' });
        try {
          await updatePassword(password);
          setMessage({ tone: 'success', text: 'Your password was changed.' });
        } catch (err) {
          setMessage({ tone: 'error', text: friendlyAuthError(err) });
        }
      }}>
        <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <Button type="submit" size="lg" className="w-full">Save password</Button>
      </form>
    </div>
  );
}

export function JoinClassPage() {
  const { db, cloud, auth, partition, online } = useApp();
  const learners = useLiveQuery(() => db.learners.filter((l) => !l.archivedAt && l.origin === 'account').toArray(), [db], []);
  const [learnerId, setLearnerId] = useState('');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (cloud.status !== 'configured') return <CloudNotConfigured />;
  if (auth.status !== 'signed_in' || partition === 'device') {
    return <Alert tone="info" action={<ButtonLink size="sm" to="/account/sign-in">Sign in</ButtonLink>}>A parent or guardian signs in to ask for a reader to join a class.</Alert>;
  }
  const learner = learners.find((l) => l.id === learnerId);
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Join a class" description="Ask the teacher for the class code. The teacher approves each request." />
      <NeedsInternet what="Joining a class" />
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        if (!learner) return setResult({ tone: 'error', text: 'Choose a reader.' });
        if (learner.cloud !== 'synced') return setResult({ tone: 'info', text: 'This reader has not synced yet. Sync first, then try again.' });
        setBusy(true);
        try {
          const response = await requestEnrollment(code, learner.id);
          setResult(response.status === 'not_found'
            ? { tone: 'error', text: 'That class code was not found. Check it with the teacher.' }
            : response.status === 'active'
              ? { tone: 'success', text: `${learner.displayName} is already in ${response.class_name}.` }
              : { tone: 'success', text: `Request sent to ${response.class_name}. The teacher will approve it.` });
        } catch (err) {
          setResult({ tone: 'error', text: /too many/i.test(String((err as Error).message)) ? 'Too many tries. Please wait an hour and try again.' : 'The request could not be sent. Check your connection.' });
        } finally {
          setBusy(false);
        }
      }}>
        <SelectField label="Reader" value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
          <option value="">Choose a reader</option>
          {learners.map((l) => <option key={l.id} value={l.id}>{l.displayName}</option>)}
        </SelectField>
        <TextField label="Class code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} autoComplete="off" hint="8 letters and numbers, for example K7QM2XPA." />
        {result ? <Alert tone={result.tone}>{result.text}</Alert> : null}
        <Button type="submit" size="lg" busy={busy} disabled={!online} className="w-full">Send request</Button>
      </form>
    </div>
  );
}
