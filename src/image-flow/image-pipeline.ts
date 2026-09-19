import { createHash } from 'node:crypto';
import type { MatchEvent } from '../domain/match-event.js';
import { logger } from '../observability/logger.js';
import { loadFullTimeScorers } from '../services/scorers.js';
import { composeEventImage } from '../services/visual-composer.js';
import { storeArtwork } from '../supabase/storage.js';
import { errorCodeOf, sanitizedErrorMessage } from './errors.js';
import { generateEventArtwork } from './generate-event-artwork.js';
import {
  claimImageJob,
  IMAGE_READY_STATUSES,
  markGenerating,
  updateImageJob,
  type ImageJob,
} from './image-jobs.js';
import { enforceXLimit, validateGenerated } from './image-validator.js';
import { buildEventImagePrompt, IMAGE_PROMPT_VERSION } from './prompt-builder.js';

export type PrepareEventImageInput = {
  matchEventId: number;
  fixtureId: number;
  event: MatchEvent;
};

/** Immutable, versioned object path (plan section 6). */
export function buildImmutableStoragePath(input: PrepareEventImageInput): string {
  const season = new Date().getUTCFullYear().toString();
  return `${season}/${input.event.matchId}/${input.matchEventId}-${IMAGE_PROMPT_VERSION}.jpg`;
}

/**
 * Orchestrates the per-event image flow (plan section 13), ending with a
 * finished JPEG at an immutable Supabase path. X upload is deliberately not
 * part of this pipeline: it belongs to x-publishing, so an X outage never
 * stalls the image job or the publish join.
 *
 * Idempotent: a stored JPEG is reused, never regenerated. The pgmq
 * visibility timeout acts as the lease, so a row stuck in
 * 'generating'/'compositing' from a crashed worker is simply reclaimed when
 * the message becomes visible again.
 *
 * No fallback image is generated on failure: if AI generation, validation,
 * or compositing fails, the job is marked 'failed' with no storage_path and
 * the event is published to X as text-only (see publish-join / x-publishing).
 */
export async function prepareEventImage(input: PrepareEventImageInput): Promise<ImageJob> {
  const { matchEventId, fixtureId, event } = input;
  const { job } = await claimImageJob(matchEventId, fixtureId);

  if (job.storage_path && IMAGE_READY_STATUSES.includes(job.status)) {
    logger.debug({ matchEventId, storagePath: job.storage_path }, 'image job already complete');
    return job;
  }
  if (job.status === 'failed') {
    logger.debug({ matchEventId }, 'image job already failed; publishing without image');
    return job;
  }

  await markGenerating(job);

  let finalJpeg: Buffer;
  let generationDurationMs: number | null = null;

  try {
    const prompt = buildEventImagePrompt(event);
    const generated = await generateEventArtwork(prompt);
    generationDurationMs = generated.durationMs;
    await validateGenerated(generated.image);

    await updateImageJob(job.id, { status: 'compositing' });
    const scorers =
      event.type === 'FULL_TIME' ? await loadFullTimeScorers(fixtureId) : undefined;
    finalJpeg = await composeEventImage(generated.image, event, { overlay: true, scorers });
    finalJpeg = await enforceXLimit(finalJpeg);
  } catch (error) {
    const lastErrorCode = errorCodeOf(error);
    const lastErrorMessage = sanitizedErrorMessage(error);
    logger.warn(
      { matchEventId, code: lastErrorCode, message: lastErrorMessage },
      'image generation failed; publishing without image',
    );
    await updateImageJob(job.id, {
      status: 'failed',
      generation_duration_ms: generationDurationMs,
      last_error_code: lastErrorCode,
      last_error_message: lastErrorMessage,
    });
    return { ...job, status: 'failed', storage_path: null } as ImageJob;
  }

  const storagePath = buildImmutableStoragePath(input);
  await storeArtwork({ objectPath: storagePath, image: finalJpeg });

  await updateImageJob(job.id, {
    status: 'stored',
    storage_path: storagePath,
    image_hash: createHash('sha256').update(finalJpeg).digest('hex'),
    byte_length: finalJpeg.length,
    generation_duration_ms: generationDurationMs,
    last_error_code: null,
    last_error_message: null,
  });

  logger.info(
    {
      matchEventId,
      storagePath,
      generationDurationMs,
      byteLength: finalJpeg.length,
      promptVersion: IMAGE_PROMPT_VERSION,
    },
    'event image prepared',
  );

  return { ...job, status: 'stored', storage_path: storagePath } as ImageJob;
}
