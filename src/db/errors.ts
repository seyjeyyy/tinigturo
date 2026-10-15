/** Raised when the browser refuses to store more data. */
export class StorageFullError extends Error {
  readonly kind = 'storage_full';
  constructor(cause?: unknown) {
    super('This device is out of storage space for Tinig Turo.');
    this.name = 'StorageFullError';
    this.cause = cause;
  }
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; inner?: unknown; code?: number; message?: string };
  if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (e.code === 22 || e.code === 1014) return true;
  if (typeof e.message === 'string' && /quota/i.test(e.message)) return true;
  // Dexie wraps the DOMException in `inner`.
  return e.inner ? isQuotaError(e.inner) : false;
}

/** Runs a local write and converts quota failures into a StorageFullError. */
export async function guardStorage<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isQuotaError(error)) throw new StorageFullError(error);
    throw error;
  }
}
