import { logger } from '../observability/logger.js';
import { listDueContentJobs, markJobStatus } from '../services/content-jobs.js';
import { QUEUES, sendToQueue } from './supabase-queues.js';

const POLL_MS = 30_000;

export async function dispatchDueContentJobs(): Promise<number> {
  const due = await listDueContentJobs(20);
  for (const job of due) {
    await markJobStatus(job.id, 'processing');
    await sendToQueue(QUEUES.influencerContent, {
      idempotencyKey: `influencer:${job.intent}:${job.source_id ?? job.id}`,
      contentJobId: job.id,
    });
  }
  if (due.length > 0) {
    logger.info({ count: due.length }, 'dispatched due content jobs');
  }
  return due.length;
}

export function startContentJobDispatcher(): () => void {
  const interval = setInterval(() => {
    void dispatchDueContentJobs().catch(error => {
      logger.error({ error }, 'content job dispatcher failed');
    });
  }, POLL_MS);
  void dispatchDueContentJobs().catch(error => {
    logger.error({ error }, 'content job dispatcher failed');
  });
  logger.info('content job dispatcher started');
  return () => clearInterval(interval);
}
