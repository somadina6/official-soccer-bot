import { ApiResponseError, EUploadMimeType } from 'twitter-api-v2';
import { getXClient } from './auth.js';

function wrapXError(error: unknown): never {
  if (error instanceof ApiResponseError) {
    throw new Error(`X ${error.code}: ${error.message}`);
  }
  throw error;
}

/** Uploads a WebP image and returns the media ID. */
export async function uploadImage(image: Buffer): Promise<string> {
  try {
    return await getXClient().v2.uploadMedia(image, {
      media_type: EUploadMimeType.Webp,
      media_category: 'tweet_image',
    });
  } catch (error) {
    wrapXError(error);
  }
}

/**
 * Attaches descriptive alt text to uploaded media. This must not fail
 * silently: publishing inaccessible media violates the accessibility and
 * transparency requirements, so callers treat a throw here as a hard error.
 */
export async function setMediaAltText(mediaId: string, altText: string): Promise<void> {
  try {
    await getXClient().v2.createMediaMetadata(mediaId, {
      alt_text: { text: altText.slice(0, 1000) },
    });
  } catch (error) {
    wrapXError(error);
  }
}
