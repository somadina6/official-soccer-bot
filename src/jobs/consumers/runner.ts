import { logger } from '../../observability/logger.js';
import { captureError } from '../../observability/sentry.js';
import {
  archiveMessage,
  deadLetter,
  readFromQueue,
  type QueueName,
  type ReadMessage,
} from '../supabase-queues.js';

const MAX_ATTEMPTS = 4;
const POLL_INTERVAL_MS = 2_000;

export type ConsumerHandler = (msg: ReadMessage) => Promise<void>;

/**
 * Generic queue consumer loop. Successful messages are archived for audit;
 * a handler throw releases the message back after the visibility timeout, and
 * jobs that exhaust MAX_ATTEMPTS move to `dead-letter` with the error recorded
 * in `job_failures`.
 */
export function startConsumer(
  queue: QueueName,
  handler: ConsumerHandler,
  options: { visibilityTimeout?: number; batchSize?: number } = {},
): () => void {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const messages = await readFromQueue(
          queue,
          options.visibilityTimeout ?? 60,
          options.batchSize ?? 5,
        );
        for (const msg of messages) {
          if (msg.readCount > MAX_ATTEMPTS) {
            await deadLetter(queue, msg, `exhausted after ${msg.readCount - 1} attempts`);
            logger.error({ queue, msgId: msg.msgId }, 'job moved to dead-letter');
            continue;
          }
          try {
            await handler(msg);
            await archiveMessage(queue, msg.msgId);
          } catch (error) {
            captureError(error, { queue, msgId: msg.msgId, attempt: msg.readCount });
            // Leave the message; it reappears after the visibility timeout.
          }
        }
        if (messages.length === 0) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      } catch (error) {
        captureError(error, { queue, scope: 'consumer-loop' });
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS * 5));
      }
    }
  };

  void loop();
  logger.info({ queue }, 'queue consumer started');
  return () => {
    running = false;
  };
}
