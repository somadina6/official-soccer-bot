import { prepareEventImage } from '../../image-flow/image-pipeline.js';
import { QUEUES } from '../supabase-queues.js';
import { maybeEnqueueXPublishing } from './publish-join.js';
import { startConsumer } from './runner.js';
import { loadEvent } from './shared.js';

/**
 * Consumes `image-generation`: builds the per-event JPEG (GPT + overlay +
 * store, with a deterministic fallback) then joins with commentary to
 * enqueue publishing. Visibility timeout is long because generation is slow.
 */
export function startImageGenerationConsumer(): () => void {
  return startConsumer(
    QUEUES.imageGeneration,
    async msg => {
      const { matchEventId, idempotencyKey } = msg.message;
      if (!Number.isFinite(matchEventId) || matchEventId <= 0) {
        throw new Error('image job missing matchEventId');
      }
      const row = await loadEvent(matchEventId);
      await prepareEventImage({
        matchEventId,
        fixtureId: row.fixture_id,
        event: row.event,
      });
      await maybeEnqueueXPublishing(matchEventId, idempotencyKey);
    },
    { visibilityTimeout: 300, batchSize: 1 },
  );
}
