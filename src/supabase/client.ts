import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../config/env.js';

let client: SupabaseClient | undefined;

/**
 * Server-only Supabase client using the service role key. This must never be
 * bundled into a browser: queue and publishing tables are private to the
 * Railway worker.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const env = loadEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
