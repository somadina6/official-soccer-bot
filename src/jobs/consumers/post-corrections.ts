import { createHash } from 'node:crypto';
import { logger } from '../../observability/logger.js';
import { publish } from '../../services/publisher.js';
import { composeEventImage, solidFallbackBackground } from '../../services/visual-composer.js';
import { getSupabase } from '../../supabase/client.js';
import { QUEUES } from '../supabase-queues.js';
import { startConsumer } from './runner.js';
import { loadEvent, setEventState } from './shared.js';

/** Natural key = idempotency key minus its trailing `:revision` suffix. */
function naturalKeyOf(idempotencyKey: string): string {
  return idempotencyKey.slice(0, idempotencyKey.lastIndexOf(':'));
}

/**
 * Consumes `post-corrections` (section 5, VAR handling): when an already
 * published goal is overturned, a concise correction is posted as a reply to
 * the original — the original is never deleted or hidden. If the goal never
 * escaped the confirmation delay, there is nothing to correct.
 */
export function startPostCorrectionsConsumer(): () => void {
  return startConsumer(QUEUES.postCorrections, async msg => {
    const { matchEventId, idempotencyKey } = msg.message;
    const row = await loadEvent(matchEventId);
    const naturalKey = naturalKeyOf(row.idempotency_key);

    // Find a published post from any earlier revision of the same incident.
    const { data: original, error } = await getSupabase()
      .from('published_posts')
      .select('x_post_id, idempotency_key')
      .like('idempotency_key', `${naturalKey}:%`)
      .eq('is_correction', false)
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`original post lookup failed: ${error.message}`);

    if (!original) {
      await setEventState(matchEventId, 'OVERTURNED');
      logger.info({ matchEventId }, 'overturned event was never published; no correction needed');
      return;
    }

    const event = row.event;
    const score = `${event.home.name} ${event.home.score}\u2013${event.away.score} ${event.away.name}`;
    const correctionText = [
      'NO GOAL. VAR HAS SPOKEN.',
      `The ${event.minute}' goal is overturned. It stays ${score}.`,
      'Celebrations returned with the receipt.',
    ].join('\n');
    const altText =
      `AI-generated editorial football illustration. Overlay: VAR decision, ` +
      `${event.home.name} ${event.home.score}\u2013${event.away.score} ${event.away.name}.`;

    const background = await solidFallbackBackground([
      ...event.home.colours,
      ...event.away.colours,
    ]);
    const image = await composeEventImage(background, { ...event, type: 'VAR' });
    const imageHash = createHash('sha256').update(image).digest('hex');

    const result = await publish({
      matchEventId,
      idempotencyKey: `${idempotencyKey}:correction`,
      postText: correctionText,
      altText,
      image,
      imageHash,
      isCorrection: true,
      inReplyToPostId: original.x_post_id,
    });

    await setEventState(matchEventId, 'OVERTURNED');
    logger.warn(
      { matchEventId, originalPostId: original.x_post_id, result: result.status },
      'VAR correction processed',
    );
  });
}
