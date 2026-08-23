import { createHash } from 'node:crypto';
import { findImageJob, IMAGE_DONE_STATUSES, IMAGE_READY_STATUSES } from '../../image-flow/image-jobs.js';
import { logger } from '../../observability/logger.js';
import { publish } from '../../services/publisher.js';
import { getSupabase } from '../../supabase/client.js';
import { downloadArtwork } from '../../supabase/storage.js';
import { QUEUES } from '../supabase-queues.js';
import { startConsumer } from './runner.js';
import { loadEvent, requireMatchEventId, setEventState } from './shared.js';

async function loadGeneration(contentGenerationId: number) {
  const { data, error } = await getSupabase()
    .from('content_generations')
    .select('id, post_text, alt_text')
    .eq('id', contentGenerationId)
    .single();
  if (error || !data) {
    throw new Error(`content_generation ${contentGenerationId} not found: ${error?.message}`);
  }
  return data;
}

/**
 * Consumes `x-publishing`: loads the already-prepared JPEG (or a valid X
 * media ID), uploads/re-uploads to X if needed, then publishes idempotently.
 * This consumer never calls OpenAI.
 */
export function startXPublishingConsumer(): () => void {
  return startConsumer(
    QUEUES.xPublishing,
    async msg => {
      const matchEventId = requireMatchEventId(msg.message.matchEventId);
      const { idempotencyKey } = msg.message;
      const contentGenerationId = Number(msg.message.contentGenerationId);
      const row = await loadEvent(matchEventId);
      if (row.state === 'PUBLISHED') return;

      const job = await findImageJob(matchEventId);
      if (!job || !IMAGE_DONE_STATUSES.includes(job.status)) {
        logger.error({ matchEventId, status: job?.status }, 'x-publishing join fired without a finished image job');
        return;
      }

      const hasImage = Boolean(job.storage_path) && IMAGE_READY_STATUSES.includes(job.status);
      if (!hasImage) {
        logger.info({ matchEventId, status: job.status }, 'no image available; publishing text-only');
      }

      const generation = await loadGeneration(contentGenerationId);
      await setEventState(matchEventId, 'PUBLISHING');

      const image = hasImage ? await downloadArtwork(job.storage_path!) : null;
      const imageHash = image ? (job.image_hash ?? createHash('sha256').update(image).digest('hex')) : null;

      const result = await publish({
        matchEventId,
        idempotencyKey,
        postText: generation.post_text,
        altText: generation.alt_text,
        ...(image ? { image, imageHash: imageHash! } : {}),
      });

      if (result.status === 'published' || result.status === 'already_published') {
        await setEventState(matchEventId, 'PUBLISHED');
        return;
      }

      // Skipped: dry run, kill switch, manual approval or rate limits. The
      // event stays VALIDATED so an operator can re-publish it deliberately.
      await setEventState(matchEventId, 'VALIDATED');
      logger.info({ matchEventId, reason: result.reason }, 'publishing skipped');
    },
    { visibilityTimeout: 120, batchSize: 2 },
  );
}
