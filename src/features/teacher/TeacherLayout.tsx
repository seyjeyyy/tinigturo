import { useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router';
import { BookA, BookText, ClipboardCheck, Lock, MonitorSmartphone, School, Undo2 } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { OfflineNotice, SyncPill } from '../../app/StatusIndicators';
import { UpdateBanner } from '../../pwa/UpdateBanner';
import { CloudNotConfigured } from '../account/AccountPages';
import { Alert, Card, PageHeader } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';
import { TextField } from '../../ui/fields';

const NAV = [
  { to: '/teacher', label: 'Classes', icon: School, end: true },
  { to: '/teacher/stories', label: 'Stories', icon: BookText, end: false },
  { to: '/teacher/review', label: 'Review', icon: ClipboardCheck, end: false },
  { to: '/teacher/vocabulary', label: 'Word meanings', icon: BookA, end: false },
  { to: '/teacher/device', label: 'This device', icon: MonitorSmartphone, end: false },
];

function UnlockScreen() {
  const { teacherLock, auth } = useApp();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const locked = attempts >= 5;
  return (
    <div className="mx-auto max-w-sm py-10">
      <PageHeader title="Teacher workspace locked" description={`Enter the PIN for ${auth.email}.`} />
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        if (locked) return;
        const ok = await teacherLock.unlock(pin);
        if (!ok) {
          setAttempts((a) => a + 1);
          setError('That PIN is not right.');
          setPin('');
        }
      }}>
        <TextField label="PIN" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={8} error={error} />
        {locked ? <Alert tone="error">Too many wrong tries. Sign in again with your password from the Account page.</Alert> : null}
        <Button type="submit" size="lg" className="w-full" disabled={locked}>Unlock</Button>
      </form>
      <p className="mt-3 text-sm text-ink-soft">The PIN only unlocks this device’s teacher screens. Class data is still protected by your account on the server.</p>
      <p className="mt-4"><Link to="/" className="underline">Back to student mode</Link></p>
    </div>
  );
}

export function TeacherLayout() {
  const { cloud, auth, isTeacher, teacherLock, online } = useApp();

  let gate: React.ReactNode = null;
  if (cloud.status !== 'configured') gate = <CloudNotConfigured />;
  else if (auth.status === 'loading') gate = <p>Loading…</p>;
  else if (auth.status !== 'signed_in') {
    gate = <Alert tone="info" title="Sign in as a teacher" action={<ButtonLink size="sm" to="/account/sign-in">Sign in</ButtonLink>}>The teacher workspace needs a teacher account.</Alert>;
  } else if (!isTeacher) {
    gate = (
      <Card>
        <h2 className="text-lg font-bold">This account does not have the teacher role</h2>
        <p className="mt-1">Teacher access is granted on the server. If you signed up as a teacher, your school administrator may need to approve it.{online ? '' : ' (You are offline, so the role could not be checked.)'}</p>
      </Card>
    );
  } else if (teacherLock.locked) gate = <UnlockScreen />;

  return (
    <div className="flex min-h-dvh flex-col bg-[#f4f7f6]">
      <a href="#teacher-main" className="skip-link">Skip to content</a>
      <UpdateBanner />
      <OfflineNotice />
      <header className="bg-teal-deep text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
          <p className="mr-auto text-lg font-bold">Tinig Turo · Teacher workspace</p>
          {!gate ? <SyncPill /> : null}
          {!gate && teacherLock.hasPin ? (
            <Button size="sm" variant="secondary" icon={<Lock size={16} />} onClick={teacherLock.lock}>Lock</Button>
          ) : null}
          <ButtonLink size="sm" variant="sun" to="/" icon={<Undo2 size={16} />} onClick={() => teacherLock.hasPin && teacherLock.lock()}>Student mode</ButtonLink>
        </div>
        {!gate ? (
          <nav aria-label="Teacher" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-3 pb-2">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={({ isActive }) => `inline-flex min-h-11 items-center gap-2 rounded-lg px-3 font-semibold ${isActive ? 'bg-white text-teal-deep' : 'text-white hover:bg-white/15'}`}>
                <Icon size={18} aria-hidden="true" />{label}
              </NavLink>
            ))}
          </nav>
        ) : null}
      </header>
      <main id="teacher-main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {gate ?? (online ? <Outlet /> : (
          <>
            <Alert tone="offline" className="mb-4">You are offline. Teacher screens show and change server data, so they need the internet. Story drafts you save offline are queued and checked for conflicts when you reconnect.</Alert>
            <Outlet />
          </>
        ))}
      </main>
    </div>
  );
}
