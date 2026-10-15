/**
 * Quick-access PIN for a teacher workspace on this device. It only unlocks local UI
 * for an account that already signed in here; it creates no cloud authorization.
 * Every server request still uses the Supabase session and is checked by RLS.
 */
export interface PinRecord {
  salt: string;
  hash: string;
  iterations: number;
}

const ITERATIONS = 150_000;

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of array) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return toBase64(bits);
}

export function validatePin(pin: string): string | null {
  if (!/^\d{4,8}$/.test(pin)) return 'Use 4 to 8 digits.';
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Choose a PIN that is harder to guess.';
  return null;
}

export async function createPinRecord(pin: string): Promise<PinRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toBase64(salt), hash: await derive(pin, salt, ITERATIONS), iterations: ITERATIONS };
}

export async function verifyPin(pin: string, record: PinRecord): Promise<boolean> {
  const hash = await derive(pin, fromBase64(record.salt), record.iterations);
  if (hash.length !== record.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}
