import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, WifiOff, XCircle } from 'lucide-react';

type Tone = 'info' | 'success' | 'warning' | 'error' | 'offline';

const toneStyles: Record<Tone, string> = {
  info: 'bg-teal-tint border-teal-brand/40 text-ink',
  success: 'bg-teal-tint border-teal-brand/40 text-ink',
  warning: 'bg-sun-tint border-sun text-ink',
  error: 'bg-danger-tint border-danger/50 text-ink',
  offline: 'bg-white border-line text-ink',
};

const toneIcons: Record<Tone, ReactNode> = {
  info: <Info size={20} />,
  success: <CheckCircle2 size={20} />,
  warning: <AlertTriangle size={20} />,
  error: <XCircle size={20} />,
  offline: <WifiOff size={20} />,
};

/** A message with an icon and text (never color alone). Errors are announced assertively. */
export function Alert({ tone = 'info', title, children, action, className = '' }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex gap-3 rounded-xl border-2 p-3 ${toneStyles[tone]} ${className}`}>
      <span aria-hidden="true" className="mt-0.5 shrink-0">{toneIcons[tone]}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-[0.95rem] leading-relaxed">{children}</div> : null}
        {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-3 py-10 text-ink-soft">
      <Loader2 className="animate-spin" size={24} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-line bg-white/60 px-6 py-10 text-center">
      {icon ? <div aria-hidden="true" className="mb-3 text-4xl">{icon}</div> : null}
      <p className="text-lg font-semibold">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-md text-ink-soft">{children}</div> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

type BadgeTone = 'neutral' | 'teal' | 'blue' | 'sun' | 'danger';
const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-white border-line text-ink',
  teal: 'bg-teal-tint border-teal-brand/40 text-teal-deep',
  blue: 'bg-blue-tint border-blue-brand/30 text-[#16348f]',
  sun: 'bg-sun-tint border-sun text-amber-ink',
  danger: 'bg-danger-tint border-danger/40 text-danger',
};

/** Status label: always icon + text. */
export function StatusBadge({ tone = 'neutral', icon, children }: { tone?: BadgeTone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium ${badgeTones[tone]}`}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm"><span>{label}</span><span>{percent}%</span></div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-3 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-teal-brand" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        {description ? <div className="mt-1 text-ink-soft">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ children, className = '', as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' | 'li' }) {
  return <As className={`rounded-2xl border-2 border-line bg-white p-4 sm:p-5 ${className}`}>{children}</As>;
}
