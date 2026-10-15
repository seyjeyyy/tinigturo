import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const control = 'w-full rounded-xl border-2 border-line bg-white px-3 py-2.5 text-base text-ink placeholder:text-ink-soft/70 focus:border-blue-brand aria-[invalid=true]:border-danger';

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block font-semibold">{label}</label>
      {hint ? <p id={hintId} className="text-sm text-ink-soft">{hint}</p> : null}
      {children({ id, describedBy })}
      {error ? <p id={errorId} className="text-sm font-medium text-danger">⚠ {error}</p> : null}
    </div>
  );
}

export function TextField({ label, hint, error, ...rest }: { label: string; hint?: ReactNode; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} aria-invalid={error ? true : undefined} className={control} {...rest} />}
    </FieldShell>
  );
}

export function TextArea({ label, hint, error, ...rest }: { label: string; hint?: ReactNode; error?: string | null } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} aria-invalid={error ? true : undefined} className={`${control} min-h-48 leading-relaxed`} {...rest} />}
    </FieldShell>
  );
}

export function SelectField({ label, hint, error, children, ...rest }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <select id={id} aria-describedby={describedBy} aria-invalid={error ? true : undefined} className={`${control} min-h-12`} {...rest}>
          {children}
        </select>
      )}
    </FieldShell>
  );
}

/** On/off switch with a visible state label. */
export function Toggle({ label, description, checked, onChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="font-semibold">{label}</p>
        {description ? <div id={`${id}-desc`} className="mt-0.5 text-sm text-ink-soft">{description}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`inline-flex min-h-12 min-w-24 shrink-0 items-center justify-center gap-2 rounded-full border-2 px-3 font-semibold disabled:opacity-50 ${checked ? 'border-teal-brand bg-teal-brand text-white' : 'border-line bg-white text-ink'}`}
      >
        <span aria-hidden="true">{checked ? '●' : '○'}</span>
        {checked ? 'On' : 'Off'}
      </button>
    </div>
  );
}
