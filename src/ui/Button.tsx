import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'sun';
type Size = 'md' | 'lg' | 'sm';

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold select-none transition-colors disabled:cursor-not-allowed disabled:opacity-55 text-center';

const variants: Record<Variant, string> = {
  primary: 'bg-teal-brand text-white hover:bg-teal-deep',
  secondary: 'bg-white text-ink border-2 border-line hover:border-teal-brand',
  ghost: 'text-teal-deep hover:bg-teal-tint',
  danger: 'bg-danger text-white hover:bg-[#912018]',
  sun: 'bg-sun text-ink hover:bg-[#e9a521]',
};

const sizes: Record<Size, string> = {
  sm: 'min-h-10 px-3 text-sm',
  md: 'min-h-12 px-4 text-base',
  lg: 'min-h-14 px-6 text-lg',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra = ''): string {
  return `${base} ${variants[variant]} ${sizes[size]} ${extra}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon, busy, children, className = '', disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {icon ? <span aria-hidden="true" className="shrink-0">{icon}</span> : null}
      {children}
    </button>
  );
});

export function ButtonLink({ variant = 'primary', size = 'md', icon, className = '', children, ...rest }: LinkProps & { variant?: Variant; size?: Size; icon?: ReactNode }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {icon ? <span aria-hidden="true" className="shrink-0">{icon}</span> : null}
      {children}
    </Link>
  );
}

export function IconButton({ label, icon, variant = 'ghost', size = 'md', className = '', ...rest }: Omit<ButtonProps, 'children'> & { label: string; icon: ReactNode }) {
  const square = size === 'lg' ? 'w-14' : size === 'sm' ? 'w-10' : 'w-12';
  return (
    <Button variant={variant} size={size} aria-label={label} title={label} className={`${square} px-0 ${className}`} {...rest}>
      <span aria-hidden="true">{icon}</span>
    </Button>
  );
}
