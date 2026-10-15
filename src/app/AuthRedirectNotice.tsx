import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Alert } from '../ui/feedback';
import { Button, ButtonLink } from '../ui/Button';

/** Reads the error Supabase Auth appends when an email link fails (query or hash). */
export function readAuthRedirectError(search: string, hash: string): { code: string; description: string } | null {
  for (const part of [search, hash.replace(/^#/, '?')]) {
    const params = new URLSearchParams(part);
    const code = params.get('error_code') ?? params.get('error');
    if (code) return { code, description: params.get('error_description') ?? '' };
  }
  return null;
}

/** Explains a failed confirmation or reset link instead of silently ignoring it. */
export function AuthRedirectNotice() {
  const location = useLocation();
  const navigate = useNavigate();
  const [error] = useState(() => readAuthRedirectError(location.search, location.hash));
  const [dismissed, setDismissed] = useState(false);
  if (!error || dismissed) return null;

  const expired = error.code === 'otp_expired' || /expired|invalid/i.test(error.description);
  const dismiss = () => {
    setDismissed(true);
    navigate(location.pathname, { replace: true });
  };
  return (
    <Alert
      tone="warning"
      className="mb-5"
      title={expired ? 'That email link no longer works' : 'The email link could not be used'}
      action={
        <>
          <ButtonLink size="sm" to="/account/sign-in" onClick={() => setDismissed(true)}>Sign in</ButtonLink>
          <Button size="sm" variant="ghost" onClick={dismiss}>Dismiss</Button>
        </>
      }
    >
      {expired
        ? 'It was already used, or a newer email replaced it. Try signing in: if your email is already confirmed it will work. If not, you can ask for a new confirmation email there.'
        : error.description || 'Please try again.'}
    </Alert>
  );
}
