import sharp from 'sharp';
import { ImageFlowError } from './errors.js';

/** Internal ceiling below X's 5 MB image limit (plan section 10). */
export const X_IMAGE_BYTE_CEILING = Math.floor(4.8 * 1024 * 1024);

const MIN_PLAUSIBLE_BYTES = 5_000;

/**
 * Verifies the model output before compositing: bytes must decode, the format
 * must be JPEG, dimensions must be sane and the object must not be
 * suspiciously small.
 */
export async function validateGenerated(image: Buffer): Promise<void> {
  if (image.length < MIN_PLAUSIBLE_BYTES) {
    throw new ImageFlowError('IMAGE_DECODE_FAILED', `implausibly small image (${image.length} bytes)`);
  }
  let meta: sharp.Metadata;
  try {
    meta = await sharp(image).metadata();
  } catch (error) {
    throw new ImageFlowError(
      'IMAGE_DECODE_FAILED',
      error instanceof Error ? error.message : 'metadata decode failed',
    );
  }
  if (meta.format !== 'jpeg') {
    throw new ImageFlowError('IMAGE_DECODE_FAILED', `expected jpeg, got ${meta.format ?? 'unknown'}`);
  }
  if (!meta.width || !meta.height || meta.width > 8192 || meta.height > 8192) {
    throw new ImageFlowError('IMAGE_DECODE_FAILED', `bad dimensions ${meta.width}x${meta.height}`);
  }
}

/**
 * Enforces the 4.8 MB internal ceiling: first re-encode at quality 80, then
 * progressively reduce dimensions while keeping the landscape ratio.
 */
export async function enforceXLimit(image: Buffer): Promise<Buffer> {
  if (image.length <= X_IMAGE_BYTE_CEILING) return image;

  let candidate = await sharp(image)
    .jpeg({ quality: 80, progressive: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
  if (candidate.length <= X_IMAGE_BYTE_CEILING) return candidate;

  const meta = await sharp(candidate).metadata();
  let width = meta.width ?? 1536;
  for (let step = 0; step < 4; step++) {
    width = Math.floor(width * 0.8);
    candidate = await sharp(candidate)
      .resize({ width })
      .jpeg({ quality: 80, progressive: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    if (candidate.length <= X_IMAGE_BYTE_CEILING) return candidate;
  }
  throw new ImageFlowError('IMAGE_TOO_LARGE', `still ${candidate.length} bytes after downscaling`);
}
