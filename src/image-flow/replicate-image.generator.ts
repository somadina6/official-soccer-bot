import Replicate from 'replicate';
import sharp from 'sharp';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { ImageFlowError } from './errors.js';
import type { GeneratedArtwork } from './gpt-image.generator.js';

let client: Replicate | undefined;

function getReplicate(): Replicate {
  if (client) return client;
  const token = loadEnv().REPLICATE_API_TOKEN;
  if (!token) {
    throw new ImageFlowError('IMAGE_GENERATION_EMPTY_RESULT', 'REPLICATE_API_TOKEN is not set');
  }
  client = new Replicate({ auth: token });
  return client;
}

export type ReplicateRun = (
  identifier: string,
  options: { input: Record<string, unknown>; signal?: AbortSignal },
) => Promise<unknown>;

type ReplicateImageEnv = {
  IMAGE_GENERATION_DEADLINE_MS: number;
  IMAGE_OUTPUT_COMPRESSION: number;
  REPLICATE_IMAGE_MODEL: string;
  REPLICATE_IMAGE_ASPECT_RATIO: string;
  REPLICATE_IMAGE_RESOLUTION?: '1k' | '2k';
};

export type ReplicateGenerateDeps = {
  run?: ReplicateRun;
  fetchImpl?: typeof fetch;
  env?: ReplicateImageEnv;
};

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const response = (error as { response?: { status?: number } }).response;
  return response?.status;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const name = (error as { name: string }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function classify(error: unknown): ImageFlowError {
  if (error instanceof ImageFlowError) return error;
  if (isAbortError(error)) {
    return new ImageFlowError('IMAGE_GENERATION_TIMEOUT', 'image request timed out');
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/nsfw|moderation|safety|content.?policy/i.test(message)) {
    return new ImageFlowError('IMAGE_GENERATION_MODERATION_BLOCKED', message);
  }
  if (httpStatusOf(error) === 429) {
    return new ImageFlowError('IMAGE_GENERATION_RATE_LIMITED', message);
  }
  return new ImageFlowError('IMAGE_GENERATION_EMPTY_RESULT', message);
}

/** Retry once only for transient provider trouble, never for prompt errors. */
function isRetryable(error: unknown): boolean {
  if (error instanceof ImageFlowError) {
    return error.code === 'IMAGE_GENERATION_RATE_LIMITED';
  }
  if (isAbortError(error)) return false;
  const status = httpStatusOf(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  return false;
}

function isFileOutput(value: unknown): value is { blob: () => Promise<Blob> } {
  return typeof value === 'object' && value !== null && typeof (value as { blob?: unknown }).blob === 'function';
}

async function bytesFromOutput(
  output: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  const value = Array.isArray(output) ? output[0] : output;
  if (value === undefined || value === null) {
    throw new ImageFlowError('IMAGE_GENERATION_EMPTY_RESULT');
  }
  if (isFileOutput(value)) {
    const blob = await value.blob();
    return Buffer.from(await blob.arrayBuffer());
  }
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    const response = await fetchImpl(value, { signal });
    if (!response.ok) {
      throw new ImageFlowError(
        'IMAGE_GENERATION_EMPTY_RESULT',
        `failed to download replicate image (${response.status})`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new ImageFlowError('IMAGE_GENERATION_EMPTY_RESULT', `unexpected replicate output type ${typeof value}`);
}

/**
 * Generates one landscape editorial JPEG via Replicate Grok Imagine. Mirrors
 * the OpenAI generator contract: product deadline, at most one 429/5xx retry,
 * JPEG bytes for the rest of the image pipeline.
 */
export async function generateReplicateArtwork(
  prompt: string,
  deps: ReplicateGenerateDeps = {},
): Promise<GeneratedArtwork> {
  const env = deps.env ?? loadEnv();
  const run: ReplicateRun =
    deps.run ??
    ((identifier, options) =>
      getReplicate().run(identifier as `${string}/${string}`, options));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const deadlineAt = Date.now() + env.IMAGE_GENERATION_DEADLINE_MS;
  const startedAt = Date.now();
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new ImageFlowError('IMAGE_GENERATION_TIMEOUT', 'deadline exhausted before request');
    }
    try {
      const input: Record<string, unknown> = {
        prompt,
        aspect_ratio: env.REPLICATE_IMAGE_ASPECT_RATIO,
      };
      if (env.REPLICATE_IMAGE_RESOLUTION) {
        input.resolution = env.REPLICATE_IMAGE_RESOLUTION;
      }
      const output = await run(env.REPLICATE_IMAGE_MODEL, {
        input,
        signal: AbortSignal.timeout(remaining),
      });
      const remainingAfterRun = deadlineAt - Date.now();
      if (remainingAfterRun <= 0) {
        throw new ImageFlowError('IMAGE_GENERATION_TIMEOUT', 'deadline exhausted before download');
      }
      const raw = await bytesFromOutput(output, fetchImpl, AbortSignal.timeout(remainingAfterRun));
      const image = await sharp(raw)
        .jpeg({ quality: env.IMAGE_OUTPUT_COMPRESSION })
        .toBuffer();
      return { image, durationMs: Date.now() - startedAt, attempts };
    } catch (error) {
      logger.warn({ attempts, error: String(error) }, 'replicate image generation attempt failed');
      const retryBudgetMs = deadlineAt - Date.now() - 1_000;
      if (attempts === 1 && isRetryable(error) && retryBudgetMs > 2_000) {
        await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 500));
        continue;
      }
      throw classify(error);
    }
  }
}
