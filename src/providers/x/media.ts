import { loadEnv } from '../../config/env.js';
import { getBotUserAccessToken } from './auth.js';

async function xJson(path: string, body: unknown): Promise<any> {
  const env = loadEnv();
  const response = await fetch(`${env.X_API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await getBotUserAccessToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`X ${response.status}: ${await response.text()}`);
  return response.json();
}

/** Uploads a base64 image via POST /2/media/upload and returns the media ID. */
export async function uploadImage(image: Buffer): Promise<string> {
  const upload = await xJson('/2/media/upload', {
    media: image.toString('base64'),
    media_category: 'tweet_image',
  });
  const mediaId = upload?.data?.id;
  if (!mediaId) throw new Error('X media upload returned no media ID');
  return String(mediaId);
}

/**
 * Attaches descriptive alt text to uploaded media. This must not fail
 * silently: publishing inaccessible media violates the accessibility and
 * transparency requirements, so callers treat a throw here as a hard error.
 */
export async function setMediaAltText(mediaId: string, altText: string): Promise<void> {
  await xJson('/2/media/metadata', {
    id: mediaId,
    metadata: { alt_text: { text: altText.slice(0, 1000) } },
  });
}
