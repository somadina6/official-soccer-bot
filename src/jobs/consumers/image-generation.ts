import { logger } from '../../observability/logger.js';
import { fixturesNeedingBackgrounds, prepareFixtureBackgrounds } from '../../services/backgrounds.js';
import { QUEUES, sendToQueue } from '../supabase-queues.js';
import { startConsumer } from './runner.js';

/**
 * Consumes `image-generation`: pre-generates the three fixture backgrounds.
 * These jobs are enqueued by the pre-kick-off scheduler, never by the live
 * event path — a live event must not block on a fresh image-model request.
 */
export function startImageGenerationConsumer(): () => void {
  return startConsumer(
    QUEUES.imageGeneration,
    async msg => {
      const fixtureId = Number(msg.message.fixtureId);
      if (!Number.isFinite(fixtureId)) throw new Error('image job missing fixtureId');
      await prepareFixtureBackgrounds(fixtureId);
    },
    // Image generation is slow; keep the message hidden long enough.
    { visibilityTimeout: 300, batchSize: 1 },
  );
}

const CHECK_INTERVAL_MS = 10 * 60_000;
const queuedFixtures = new Set<number>();

/**
 * Every 10 minutes, enqueues background preparation for fixtures kicking off
 * within the next 60 minutes (section 8's 30–60 minute preparation window).
 */
export function startBackgroundPrepScheduler(): () => void {
  const tick = async () => {
    const fixtureIds = await fixturesNeedingBackgrounds();
    for (const fixtureId of fixtureIds) {
      if (queuedFixtures.has(fixtureId)) continue;
      queuedFixtures.add(fixtureId);
      await sendToQueue(QUEUES.imageGeneration, {
        idempotencyKey: `background-prep:${fixtureId}`,
        matchEventId: 0,
        fixtureId,
      });
      logger.info({ fixtureId }, 'queued fixture background preparation');
    }
  };

  void tick().catch(err => logger.error({ err }, 'background prep scheduling failed'));
  const interval = setInterval(() => {
    void tick().catch(err => logger.error({ err }, 'background prep scheduling failed'));
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(interval);
}
