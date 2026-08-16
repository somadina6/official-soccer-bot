import { logger } from '../../observability/logger.js';
import { findImageJob, IMAGE_READY_STATUSES } from '../../image-flow/image-jobs.js';
import { getSupabase } from '../../supabase/client.js';
import { QUEUES, sendToQueue } from '../supabase-queues.js';
import { loadEvent } from './shared.js';

async function latestApprovedGenerationId(matchEventId: number): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from('content_generations')
    .select('id')
    .eq('match_event_id', matchEventId)
    .eq('validation_passed', true)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`content generation lookup failed: ${error.message}`);
  return data?.id ?? null;
}

/**
 * Join gate for the parallel content + image fan-out. Enqueues `x-publishing`
 * only when commentary is VALIDATED and a JPEG is stored. Whichever side
 * finishes last does the enqueue; duplicate messages are safe because
 * publishing is idempotent.
 */
export async function maybeEnqueueXPublishing(
  matchEventId: number,
  idempotencyKey: string,
): Promise<void> {
  const row = await loadEvent(matchEventId);
  if (row.state === 'PUBLISHED') return;
  if (row.state !== 'VALIDATED' && row.state !== 'PUBLISHING') {
    logger.debug({ matchEventId, state: row.state }, 'publish join: content not ready');
    return;
  }

  const job = await findImageJob(matchEventId);
  if (!job?.storage_path || !IMAGE_READY_STATUSES.includes(job.status)) {
    logger.debug({ matchEventId, status: job?.status }, 'publish join: image not ready');
    return;
  }

  const contentGenerationId = await latestApprovedGenerationId(matchEventId);
  if (!contentGenerationId) {
    logger.debug({ matchEventId }, 'publish join: no approved commentary yet');
    return;
  }

  await sendToQueue(QUEUES.xPublishing, {
    idempotencyKey,
    matchEventId,
    contentGenerationId,
  });
  logger.info({ matchEventId, contentGenerationId }, 'enqueued x-publishing');
}
