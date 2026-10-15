// Supabase Edge Function: deletes uploaded reading recordings whose retention period
// has passed (classes.audio_retention_days, 30 days by default) and records the
// deletion on the session. Runs with the service-role key, which exists only in the
// Edge Function environment, never in the browser.
//
// Schedule it daily (see docs/SUPABASE_SETUP.md). Requests must carry the shared
// secret in the `x-purge-secret` header in addition to a valid JWT.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const BATCH = 200;

Deno.serve(async (request) => {
  const secret = Deno.env.get('PURGE_AUDIO_SECRET');
  if (!secret || request.headers.get('x-purge-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let deleted = 0;
  const failures: string[] = [];
  for (;;) {
    const { data: expired, error } = await supabase
      .from('reading_sessions')
      .select('id, audio_path')
      .eq('audio_status', 'uploaded')
      .lt('audio_expires_at', new Date().toISOString())
      .limit(BATCH);
    if (error) return new Response(JSON.stringify({ error: error.message, deleted }), { status: 500 });
    if (!expired?.length) break;

    const paths = expired.map((row) => row.audio_path).filter((p): p is string => Boolean(p));
    const removal = await supabase.storage.from('reading-audio').remove(paths);
    if (removal.error) return new Response(JSON.stringify({ error: removal.error.message, deleted }), { status: 500 });

    for (const row of expired) {
      const marked = await supabase.rpc('mark_audio_deleted', { p_session_id: row.id });
      if (marked.error) failures.push(row.id);
      else deleted++;
    }
    if (expired.length < BATCH || failures.length > 50) break;
  }

  return new Response(JSON.stringify({ deleted, failures }), { headers: { 'content-type': 'application/json' } });
});
