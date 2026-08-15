import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { getSupabase } from './client.js';

/**
 * Optionally retains final artwork in the private bucket at
 * `generated-match-media/{season}/{matchId}/{eventId}.webp`. When no bucket
 * is configured the worker streams images directly to X and returns null.
 */
export async function storeArtwork(params: {
  season: string;
  matchId: string;
  eventId: string;
  image: Buffer;
}): Promise<string | null> {
  const env = loadEnv();
  if (!env.SUPABASE_STORAGE_BUCKET) return null;

  const objectPath = `${params.season}/${params.matchId}/${params.eventId}.webp`;
  const { error } = await getSupabase()
    .storage.from(env.SUPABASE_STORAGE_BUCKET)
    .upload(objectPath, params.image, { contentType: 'image/webp', upsert: true });

  if (error) {
    // Retention is an audit nicety, not a publishing dependency.
    logger.warn({ objectPath, error: error.message }, 'artwork retention failed');
    return null;
  }
  return objectPath;
}
