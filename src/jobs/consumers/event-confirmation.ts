import { logger } from '../../observability/logger.js';
import { confirmEvent } from '../../services/confirmation.js';
import { QUEUES, sendToQueue } from '../supabase-queues.js';
import { startConsumer } from './runner.js';
import { loadEvent, setEventState } from './shared.js';

/**
 * Consumes `event-confirmation`: after the delay window, re-verifies the
 * incident against REST and either fans out to content + image generation,
 * routes an overturn to corrections, or ignores a vanished incident.
 */
export function startEventConfirmationConsumer(): () => void {
  return startConsumer(QUEUES.eventConfirmation, async msg => {
    const { matchEventId, idempotencyKey } = msg.message;
    const row = await loadEvent(matchEventId);
    if (row.state !== 'PENDING_CONFIRMATION') {
      logger.debug({ matchEventId, state: row.state }, 'event no longer pending; skipping');
      return;
    }

    const result = await confirmEvent(matchEventId);

    if (result.outcome === 'confirmed') {
      await setEventState(matchEventId, 'CONFIRMED');
      await sendToQueue(QUEUES.contentGeneration, { idempotencyKey, matchEventId });
      await sendToQueue(QUEUES.imageGeneration, { idempotencyKey, matchEventId });
      return;
    }

    if (result.outcome === 'overturned') {
      await setEventState(matchEventId, 'OVERTURNED');
      await sendToQueue(QUEUES.postCorrections, { idempotencyKey, matchEventId });
      return;
    }

    // not_found: the incident disappeared inside the confirmation window
    // (e.g. instantly-overturned VAR goal that never escaped the delay).
    await setEventState(matchEventId, 'IGNORED');
    logger.info({ matchEventId }, 'incident vanished during confirmation window; ignored');
  });
}
