import { NavLink, Navigate, Outlet, Link, useLocation } from 'react-router';
import { BookMarked, BookOpen, Download, Home, Settings, Sprout, Users } from 'lucide-react';
import { useApp } from './AppContext';
import { OfflineNotice, SyncPill } from './StatusIndicators';
import { UpdateBanner } from '../pwa/UpdateBanner';
import { AuthRedirectNotice } from './AuthRedirectNotice';
import { avatarById } from '../domain/types';
import { Loading } from '../ui/feedback';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/stories', label: 'Stories', icon: BookOpen, end: false },
  { to: '/words', label: 'My Words', icon: BookMarked, end: false },
  { to: '/progress', label: 'Progress', icon: Sprout, end: false },
];

function navClass({ isActive }: { isActive: boolean }) {
  return `flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-sm font-semibold md:flex-none md:flex-row md:gap-2 md:px-4 md:text-base ${
    isActive ? 'bg-teal-tint text-teal-deep' : 'text-ink hover:bg-white'
  }`;
}

export function StudentLayout() {
  const { learner, ready } = useApp();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link">Skip to content</a>
      <UpdateBanner />
      <OfflineNotice />
      <header className="border-b-2 border-line bg-paper">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2">
          <Link to="/" className="mr-auto flex items-center gap-2 rounded-lg py-1 text-xl font-extrabold text-teal-deep">
            <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-xl bg-sun text-lg">📖</span>
            Tinig Turo
          </Link>
          <nav aria-label="Main" className="hidden gap-1 md:flex">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={navClass}>
                <Icon size={20} aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </nav>
          <SyncPill />
          {learner ? (
            <Link to="/learners" className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line bg-white px-3 text-sm font-semibold" aria-label={`Reader: ${learner.displayName}. Switch reader`}>
              <span aria-hidden="true" className="text-lg">{avatarById(learner.avatar).emoji}</span>
              <span className="max-w-28 truncate">{learner.displayName}</span>
              <Users size={16} aria-hidden="true" />
            </Link>
          ) : null}
          <Link to="/settings" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-white" aria-label="Settings">
            <Settings size={20} aria-hidden="true" />
          </Link>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-5 md:pb-10">
        <AuthRedirectNotice />
        {ready ? <Outlet /> : <Loading label="Opening your stories…" />}
      </main>
      <footer className="mx-auto hidden w-full max-w-5xl gap-4 px-4 pb-6 text-sm text-ink-soft md:flex">
        <Link to="/downloads" className="inline-flex items-center gap-1 underline"><Download size={14} aria-hidden="true" />Offline downloads</Link>
        <Link to="/account" className="underline">Grown-ups: account and teacher workspace</Link>
      </footer>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex gap-1 border-t-2 border-line bg-paper px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 md:hidden">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={navClass}>
            <Icon size={22} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Student pages other than Home need a selected reader. */
export function RequireLearner() {
  const { learner, ready } = useApp();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!learner) return <Navigate to="/" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
