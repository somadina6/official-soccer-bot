import { logger } from '../observability/logger.js';
import { getSupabase } from '../supabase/client.js';

/**
 * Durable jobs via Supabase Queues (`pgmq_public` RPCs).
 * https://supabase.com/docs/guides/queues/api
 *
 * Called with the server-only secret key. Do not expose these queues to
 * browsers; `pgmq_public` stays private to the worker.
 */

export const QUEUES = {
  eventConfirmation: 'event-confirmation',
  contentGeneration: 'content-generation',
  imageGeneration: 'image-generation',
  xPublishing: 'x-publishing',
  postCorrections: 'post-corrections',
  deadLetter: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Every queue message carries the event's idempotency key (section 5). */
export type QueueMessage = {
  idempotencyKey: string;
  matchEventId: number;
  attempt?: number;
  [extra: string]: unknown;
};

export type ReadMessage = {
  msgId: number;
  readCount: number;
  message: QueueMessage;
};

type PgmqReadRow = {
  msg_id: number | string;
  read_ct: number;
  message: QueueMessage;
};

async function queueRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().schema('pgmq_public').rpc(fn, args);
  if (error) throw new Error(`pgmq_public.${fn} failed: ${error.message}`);
  return data as T;
}

export async function sendToQueue(
  queue: QueueName,
  message: QueueMessage,
  sleepSeconds = 0,
): Promise<number> {
  logger.info({ queue, message, sleepSeconds }, 'sending to queue');
  const msgId = await queueRpc<number | number[]>('send', {
    queue_name: queue,
    message,
    sleep_seconds: sleepSeconds,
  });
  return Array.isArray(msgId) ? Number(msgId[0]) : Number(msgId);
}

/** Reads up to `qty` messages, hiding them for `visibilityTimeout` seconds. */
export async function readFromQueue(
  queue: QueueName,
  visibilityTimeout = 60,
  qty = 5,
): Promise<ReadMessage[]> {
  // logger.debug({ queue, visibilityTimeout, qty }, 'reading from queue');
  const rows = await queueRpc<PgmqReadRow[] | null>('read', {
    queue_name: queue,
    sleep_seconds: visibilityTimeout,
    n: qty,
  });
  return (rows ?? []).map(row => ({
    msgId: Number(row.msg_id),
    readCount: row.read_ct,
    message: row.message,
  }));
}

/** Archives a successfully processed message for audit (kept in pgmq archive). */
export async function archiveMessage(queue: QueueName, msgId: number): Promise<void> {
  logger.info({ queue, msgId }, 'archiving message');
  await queueRpc('archive', { queue_name: queue, message_id: msgId });
}

/** Deletes a message outright (used after moving it to the dead-letter queue). */
export async function deleteMessage(queue: QueueName, msgId: number): Promise<void> {
  logger.info({ queue, msgId }, 'deleting message');
  await queueRpc('delete', { queue_name: queue, message_id: msgId });
}

/** Moves an exhausted job to `dead-letter` and records the failure. */
export async function deadLetter(
  queue: QueueName,
  msg: ReadMessage,
  error: string,
): Promise<void> {
  logger.info({ queue, msg, error }, 'dead-lettering message');
  await sendToQueue(QUEUES.deadLetter, {
    ...msg.message,
    sourceQueue: queue,
    error,
    attempts: msg.readCount,
  });
  logger.info({ queue, msg, error }, 'inserting job failure');
  const { error: insertError } = await getSupabase().from('job_failures').insert({
    queue_name: queue,
    message: msg.message,
    error,
    attempts: msg.readCount,
  });
  if (insertError) {
    throw new Error(`job_failures insert failed: ${insertError.message}`);
  }
  await deleteMessage(queue, msg.msgId);
}

export async function closeQueuePool(): Promise<void> {
  // Queues now go through the Supabase client; nothing to close.
}
