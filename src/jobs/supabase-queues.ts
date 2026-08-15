import pg from 'pg';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';

/**
 * Durable job queues on Supabase Queues (pgmq), consumed over a direct
 * server-side Postgres connection. Queues are never exposed to browsers.
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

let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (pool) return pool;
  const env = loadEnv();
  pool = new pg.Pool({ connectionString: env.SUPABASE_DB_URL, max: 5 });
  pool.on('error', err => logger.error({ err }, 'postgres pool error'));
  return pool;
}

export async function sendToQueue(
  queue: QueueName,
  message: QueueMessage,
  sleepSeconds = 0,
): Promise<number> {
  const { rows } = await getPool().query<{ send: number }>(
    'select * from pgmq.send(queue_name => $1, msg => $2::jsonb, delay => $3::int)',
    [queue, JSON.stringify(message), sleepSeconds],
  );
  return rows[0]!.send;
}

/** Reads up to `qty` messages, hiding them for `visibilityTimeout` seconds. */
export async function readFromQueue(
  queue: QueueName,
  visibilityTimeout = 60,
  qty = 5,
): Promise<ReadMessage[]> {
  const { rows } = await getPool().query<{
    msg_id: string;
    read_ct: number;
    message: QueueMessage;
  }>('select msg_id, read_ct, message from pgmq.read(queue_name => $1, vt => $2::int, qty => $3::int)', [
    queue,
    visibilityTimeout,
    qty,
  ]);
  return rows.map(row => ({
    msgId: Number(row.msg_id),
    readCount: row.read_ct,
    message: row.message,
  }));
}

/** Archives a successfully processed message for audit (kept in pgmq archive). */
export async function archiveMessage(queue: QueueName, msgId: number): Promise<void> {
  await getPool().query('select pgmq.archive(queue_name => $1, msg_id => $2::bigint)', [queue, msgId]);
}

/** Deletes a message outright (used after moving it to the dead-letter queue). */
export async function deleteMessage(queue: QueueName, msgId: number): Promise<void> {
  await getPool().query('select pgmq.delete(queue_name => $1, msg_id => $2::bigint)', [queue, msgId]);
}

/** Moves an exhausted job to `dead-letter` and records the failure. */
export async function deadLetter(
  queue: QueueName,
  msg: ReadMessage,
  error: string,
): Promise<void> {
  await sendToQueue(QUEUES.deadLetter, {
    ...msg.message,
    sourceQueue: queue,
    error,
    attempts: msg.readCount,
  });
  await getPool().query(
    'insert into job_failures (queue_name, message, error, attempts) values ($1, $2::jsonb, $3, $4)',
    [queue, JSON.stringify(msg.message), error, msg.readCount],
  );
  await deleteMessage(queue, msg.msgId);
}

export async function closeQueuePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
