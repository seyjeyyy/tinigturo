/**
 * Browser configuration. Only the project URL and the publishable key may be used in
 * the browser. A secret / service-role key here would give every visitor full
 * database access, so the app refuses to start the cloud client if it sees one.
 */
export interface CloudConfig {
  url: string;
  publishableKey: string;
}

export type CloudConfigState =
  | { status: 'configured'; config: CloudConfig }
  | { status: 'missing'; missing: string[] }
  | { status: 'unsafe'; reason: string };

function decodeJwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

export function evaluateCloudConfig(env: Record<string, string | undefined>): CloudConfigState {
  const url = env.VITE_SUPABASE_URL?.trim() ?? '';
  const publishableKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  const missing: string[] = [];
  if (!url) missing.push('VITE_SUPABASE_URL');
  if (!publishableKey) missing.push('VITE_SUPABASE_PUBLISHABLE_KEY');
  if (missing.length) return { status: 'missing', missing };
  if (publishableKey.startsWith('sb_secret_') || decodeJwtRole(publishableKey) === 'service_role') {
    return { status: 'unsafe', reason: 'A secret (service-role) key was provided to the browser. Use the publishable key.' };
  }
  try {
    new URL(url);
  } catch {
    return { status: 'missing', missing: ['VITE_SUPABASE_URL (not a valid URL)'] };
  }
  return { status: 'configured', config: { url, publishableKey } };
}

export const cloudConfigState: CloudConfigState = evaluateCloudConfig(import.meta.env as Record<string, string | undefined>);

export const featureFlags = {
  voskEnabled: import.meta.env.VITE_ENABLE_VOSK === 'true',
  voskModelUrlEn: (import.meta.env.VITE_VOSK_MODEL_URL_EN as string | undefined) ?? '',
};
