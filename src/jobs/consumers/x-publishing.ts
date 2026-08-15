import { createHash } from 'node:crypto';
import { logger } from '../../observability/logger.js';
import { getBackgroundForEvent } from '../../services/backgrounds.js';
import { publish } from '../../services/publisher.js';
import { composeEventImage } from '../../services/visual-composer.js';
import { storeArtwork } from '../../supabase/storage.js';
import { getSupabase } from '../../supabase/client.js';
import { QUEUES } from '../supabase-queues.js';
import { startConsumer } from './runner.js';
import { loadEvent, setEventState } from './shared.js';

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
 * Consumes `x-publishing`: composes the final image from the prepared
 * background, then publishes idempotently. A retry of the same job finds the
 * existing X post ID and never posts twice (Phase 4 exit criterion).
 */
export function startXPublishingConsumer(): () => void {
  return startConsumer(
    QUEUES.xPublishing,
    async msg => {
      const { matchEventId, idempotencyKey } = msg.message;
      const contentGenerationId = Number(msg.message.contentGenerationId);
      const row = await loadEvent(matchEventId);
      if (row.state === 'PUBLISHED') return; // idempotent replay

      const generation = await loadGeneration(contentGenerationId);
      await setEventState(matchEventId, 'PUBLISHING');

      const background = await getBackgroundForEvent(row.fixture_id, row.event);
      const image = await composeEventImage(background, row.event);
      const imageHash = createHash('sha256').update(image).digest('hex');

      const result = await publish({
        matchEventId,
        idempotencyKey,
        postText: generation.post_text,
        altText: generation.alt_text,
        image,
        imageHash,
      });

      if (result.status === 'published' || result.status === 'already_published') {
        await setEventState(matchEventId, 'PUBLISHED');
        await storeArtwork({
          season: new Date().getUTCFullYear().toString(),
          matchId: row.event.matchId,
          eventId: String(matchEventId),
          image,
        });
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
