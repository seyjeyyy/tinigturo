import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cloudConfigState } from './config';

let client: SupabaseClient | null = null;

/** Returns the Supabase client, or null when cloud features are not configured. */
export function getSupabase(): SupabaseClient | null {
  if (cloudConfigState.status !== 'configured') return null;
  if (!client) {
    client = createClient(cloudConfigState.config.url, cloudConfigState.config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: 'tinigturo-auth',
      },
    });
  }
  return client;
}

export function requireSupabase(): SupabaseClient {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Cloud features are not configured for this copy of Tinig Turo.');
  return supabase;
}
