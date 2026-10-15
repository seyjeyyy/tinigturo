export type RemoteErrorKind =
  | 'network' // offline, DNS, timeout: retry later
  | 'auth' // session missing or expired: sign in again, keep data
  | 'conflict' // version check failed: surface to the user
  | 'forbidden' // not authorized: do not retry automatically
  | 'validation' // the server rejected the data: do not retry automatically
  | 'rate_limited'
  | 'server'; // transient server error: retry with backoff

export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'RemoteError';
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'server' || this.kind === 'rate_limited';
  }
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  status?: number;
  statusCode?: string | number;
  name?: string;
}

/** Maps Supabase/PostgREST/Storage/fetch errors onto a small set of sync outcomes. */
export function classifyError(error: unknown, status?: number): RemoteError {
  if (error instanceof RemoteError) return error;
  const e = (error ?? {}) as PostgrestLikeError;
  const message = e.message ?? String(error);
  const httpStatus = status ?? e.status ?? (e.statusCode !== undefined ? Number(e.statusCode) : undefined);
  const code = e.code ?? '';

  if (error instanceof TypeError || /Failed to fetch|NetworkError|Load failed|fetch failed|network/i.test(message)) {
    return new RemoteError('network', 'No connection to the server.', error);
  }
  if (code === 'PT401' || code === 'PGRST301' || code === 'PGRST302' || httpStatus === 401 || /JWT|jwt expired|refresh token/i.test(message)) {
    return new RemoteError('auth', 'Your sign-in has expired.', error);
  }
  if (code === 'PT409' || httpStatus === 409) return new RemoteError('conflict', message, error);
  if (code === 'PT429' || httpStatus === 429) return new RemoteError('rate_limited', message, error);
  if (code === 'PT403' || code === '42501' || httpStatus === 403) return new RemoteError('forbidden', message, error);
  if (code === 'PT404' || code === 'PT422' || code.startsWith('22') || code.startsWith('23') || httpStatus === 400 || httpStatus === 404 || httpStatus === 422) {
    return new RemoteError('validation', message, error);
  }
  if (httpStatus !== undefined && httpStatus >= 500) return new RemoteError('server', message, error);
  return new RemoteError('server', message, error);
}
