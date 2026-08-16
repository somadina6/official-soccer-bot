import OpenAI, { APIConnectionTimeoutError, APIError } from 'openai';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { ImageFlowError } from './errors.js';

let client: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (client) return client;
  client = new OpenAI({ apiKey: loadEnv().OPENAI_API_KEY });
  return client;
}

export type GeneratedArtwork = {
  image: Buffer;
  durationMs: number;
  attempts: number;
};

function classify(error: unknown): ImageFlowError {
  if (error instanceof ImageFlowError) return error;
  if (error instanceof APIConnectionTimeoutError) {
    return new ImageFlowError('IMAGE_GENERATION_TIMEOUT', 'image request timed out');
  }
  if (error instanceof APIError) {
    if (error.code === 'moderation_blocked' || /moderation/i.test(error.message)) {
      return new ImageFlowError('IMAGE_GENERATION_MODERATION_BLOCKED', error.message);
    }
    if (error.status === 429) {
      return new ImageFlowError('IMAGE_GENERATION_RATE_LIMITED', error.message);
    }
  }
  return new ImageFlowError(
    'IMAGE_GENERATION_EMPTY_RESULT',
    error instanceof Error ? error.message : String(error),
  );
}

/** Retry once only for transient provider trouble, never for prompt errors. */
function isRetryable(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) return false; // deadline spent
  if (error instanceof APIError) {
    if (error.code === 'moderation_blocked' || /moderation/i.test(error.message)) return false;
    return error.status === 429 || (error.status !== undefined && error.status >= 500);
  }
  return false;
}

/**
 * Generates one landscape editorial JPEG for a confirmed event (plan section
 * 9): low quality, 1536x1024, JPEG at the configured compression, hard
 * product deadline, at most one retry with short jitter when a 429/5xx leaves
 * enough deadline remaining.
 */
export async function generateEventArtwork(prompt: string): Promise<GeneratedArtwork> {
  const env = loadEnv();
  const deadlineAt = Date.now() + env.IMAGE_GENERATION_DEADLINE_MS;
  const startedAt = Date.now();
  let attempts = 0;

  // One initial call plus at most one retry.
  for (;;) {
    attempts += 1;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new ImageFlowError('IMAGE_GENERATION_TIMEOUT', 'deadline exhausted before request');
    }
    try {
      const result = await getOpenAI().images.generate(
        {
          model: env.OPENAI_IMAGE_MODEL,
          prompt,
          quality: 'low',
          size: '1536x1024',
          output_format: 'jpeg',
          output_compression: env.IMAGE_OUTPUT_COMPRESSION,
          n: 1,
        },
        { timeout: remaining, maxRetries: 0 },
      );
      const b64 = result.data?.[0]?.b64_json;
      if (!b64) throw new ImageFlowError('IMAGE_GENERATION_EMPTY_RESULT');
      return {
        image: Buffer.from(b64, 'base64'),
        durationMs: Date.now() - startedAt,
        attempts,
      };
    } catch (error) {
      // A client-side timeout does not cancel a request already being
      // processed; the attempt still counts toward cost metrics.
      logger.warn({ attempts, error: String(error) }, 'image generation attempt failed');
      const retryBudgetMs = deadlineAt - Date.now() - 1_000;
      if (attempts === 1 && isRetryable(error) && retryBudgetMs > 2_000) {
        await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 500));
        continue;
      }
      throw classify(error);
    }
  }
}
