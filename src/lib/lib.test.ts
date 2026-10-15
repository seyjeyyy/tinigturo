import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';
import { createPinRecord, validatePin, verifyPin } from './pin';
import { evaluateCloudConfig } from '../backend/config';
import { classifyError } from '../backend/errors';
import { backoffDelay } from '../sync/outbox';
import { UpdateStore } from '../pwa/updateStore';

describe('CSV export', () => {
  it('quotes values and neutralizes spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['Name'], [['Niño']])).toBe('Name\r\nNiño\r\n');
  });
});

describe('teacher PIN', () => {
  it('rejects weak PINs and verifies with a salted hash', async () => {
    expect(validatePin('1234')).not.toBeNull();
    expect(validatePin('0000')).not.toBeNull();
    expect(validatePin('12')).not.toBeNull();
    expect(validatePin('4826')).toBeNull();
    const record = await createPinRecord('4826');
    expect(record.hash).not.toContain('4826');
    expect(await verifyPin('4826', record)).toBe(true);
    expect(await verifyPin('4827', record)).toBe(false);
  });
});

describe('browser configuration safety', () => {
  it('refuses a service-role key in the browser', () => {
    const payload = btoa(JSON.stringify({ role: 'service_role' }));
    expect(evaluateCloudConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: `h.${payload}.s` }).status).toBe('unsafe');
    expect(evaluateCloudConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' }).status).toBe('unsafe');
    expect(evaluateCloudConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc' }).status).toBe('configured');
    expect(evaluateCloudConfig({})).toEqual({ status: 'missing', missing: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'] });
  });
});

describe('error classification', () => {
  it('maps server responses onto sync outcomes', () => {
    expect(classifyError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(classifyError({ code: 'PGRST301', message: 'JWT expired' }).kind).toBe('auth');
    expect(classifyError({ code: 'PT409', message: 'changed' }).kind).toBe('conflict');
    expect(classifyError({ code: '42501', message: 'denied' }).kind).toBe('forbidden');
    expect(classifyError({ code: 'PT422', message: 'bad' }).kind).toBe('validation');
    expect(classifyError({ message: 'oops' }, 503).kind).toBe('server');
  });
});

describe('backoff', () => {
  it('grows exponentially and is capped', () => {
    expect(backoffDelay(1, () => 1)).toBe(5_000);
    expect(backoffDelay(2, () => 1)).toBe(10_000);
    expect(backoffDelay(4, () => 1)).toBe(40_000);
    expect(backoffDelay(30, () => 1)).toBe(30 * 60_000);
    expect(backoffDelay(3, () => 0)).toBe(10_000);
  });
});

describe('service-worker update gate', () => {
  it('never activates an update during a recording', async () => {
    const store = new UpdateStore();
    let applied = 0;
    store.attach(async () => {
      applied++;
    });
    store.markNeedRefresh();
    expect(await store.apply({ recordingActive: true })).toBe(false);
    expect(applied).toBe(0);
    expect(store.isDeferred).toBe(true);
    expect(await store.apply({ recordingActive: false })).toBe(true);
    expect(applied).toBe(1);
  });
});

describe('auth email link errors', () => {
  it('reads Supabase errors from the query string or the hash', async () => {
    const { readAuthRedirectError } = await import('../app/AuthRedirectNotice');
    const query = '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
    expect(readAuthRedirectError(query, '')).toEqual({ code: 'otp_expired', description: 'Email link is invalid or has expired' });
    expect(readAuthRedirectError('', '#error=access_denied&error_code=otp_expired&error_description=x')?.code).toBe('otp_expired');
    expect(readAuthRedirectError('?mode=read', '')).toBeNull();
  });
});
