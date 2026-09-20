import { loadEnv } from '../config/env.js';
import { ImageFlowError } from '../image-flow/errors.js';
import { logger } from '../observability/logger.js';
import { getSupabase } from './client.js';

function bucket() {
  return loadEnv().SUPABASE_STORAGE_BUCKET;
}

function isAlreadyExists(error: { message?: string; statusCode?: string | number | undefined }): boolean {
  const status = String(error.statusCode ?? '');
  return status === '409' || /already exists|duplicate/i.test(error.message ?? '');
}

async function uploadObject(objectPath: string, image: Buffer, contentType: string): Promise<string> {
  const { error } = await getSupabase()
    .storage.from(bucket())
    .upload(objectPath, image, {
      contentType,
      cacheControl: '31536000',
      upsert: false,
    });

  if (error && !isAlreadyExists(error)) {
    throw new ImageFlowError('STORAGE_UPLOAD_FAILED', error.message);
  }
  if (error) {
    logger.info({ objectPath }, 'storage object already exists; reusing');
  }
  return objectPath;
}

/**
 * Uploads the finalized JPEG to an immutable, versioned path. `upsert: false`
 * so a duplicate-object response reuses the existing object instead of
 * overwriting it (plan section 11).
 */
export async function storeArtwork(params: {
  objectPath: string;
  image: Buffer;
}): Promise<string> {
  return uploadObject(params.objectPath, params.image, 'image/jpeg');
}

/**
 * Caches a team crest PNG fetched from SportsAPI, under the same bucket as
 * generated artwork (`crests/{teamId}.png` — see loadTeamCrest). Crests
 * don't change shape often enough to need invalidation, so a cache hit is
 * permanent, same as storeArtwork.
 */
export async function storeCrest(params: { objectPath: string; image: Buffer }): Promise<string> {
  return uploadObject(params.objectPath, params.image, 'image/png');
}

/** Downloads a previously stored JPEG for X re-upload without regenerating. */
export async function downloadArtwork(objectPath: string): Promise<Buffer> {
  const { data, error } = await getSupabase().storage.from(bucket()).download(objectPath);
  if (error || !data) {
    throw new ImageFlowError(
      'STORAGE_DOWNLOAD_FAILED',
      error?.message ?? `empty download for ${objectPath}`,
    );
  }
  return Buffer.from(await data.arrayBuffer());
}
