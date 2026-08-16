import { ApiResponseError, EUploadMimeType } from "twitter-api-v2";
import { ImageFlowError } from "../../image-flow/errors.js";
import { getXClient } from "./auth.js";

/** Unused X media typically expires after 24 hours; used as the default TTL. */
export const X_MEDIA_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export type XMediaUploadResult = {
  mediaId: string;
  expiresAfterSeconds: number;
  expiresAt: Date;
};

function wrapXError(error: unknown): never {
  if (error instanceof ApiResponseError) {
    throw new ImageFlowError(
      "X_MEDIA_UPLOAD_FAILED",
      `X ${error.code}: ${error.message}`,
    );
  }
  if (error instanceof Error) {
    throw new ImageFlowError("X_MEDIA_UPLOAD_FAILED", error.message);
  }
  throw error;
}

/** True when a persisted media ID is missing or past its expiry (with 60s headroom). */
export function isXMediaExpired(
  expiresAt: string | Date | null | undefined,
): boolean {
  if (!expiresAt) return true;
  const ms =
    expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return true;
  return ms <= Date.now() + 60_000;
}

/** Uploads a JPEG and returns the media ID plus computed expiry. */
export async function uploadImage(image: Buffer): Promise<XMediaUploadResult> {
  try {
    const mediaId = await getXClient().v2.uploadMedia(image, {
      media_type: EUploadMimeType.Jpeg,
      media_category: "tweet_image",
    });
    return {
      mediaId,
      expiresAfterSeconds: X_MEDIA_DEFAULT_TTL_SECONDS,
      expiresAt: new Date(Date.now() + X_MEDIA_DEFAULT_TTL_SECONDS * 1000),
    };
  } catch (error) {
    wrapXError(error);
  }
}

/**
 * Attaches descriptive alt text to uploaded media. This must not fail
 * silently: publishing inaccessible media violates the accessibility and
 * transparency requirements, so callers treat a throw here as a hard error.
 */
export async function setMediaAltText(
  mediaId: string,
  altText: string,
): Promise<void> {
  try {
    await getXClient().v2.createMediaMetadata(mediaId, {
      alt_text: { text: altText.slice(0, 1000) },
    });
  } catch (error) {
    wrapXError(error);
  }
}
