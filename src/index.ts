import { loadEnv } from './config/env.js';
import { logger } from './observability/logger.js';
import { initSentry } from './observability/sentry.js';
import { startApiServer } from './api/server.js';
import { SportsFeed } from './providers/sportsapi/websocket-client.js';
import {
  loadOrDiscoverAndApproveCompetition,
  startFixtureSyncSchedule,
  syncSchedule,
  reconcileCurrentlyLive,
  type Competition,
} from './services/fixture-sync.js';
import {
  discoverUnexpectedLiveFixture,
  ingestAndDiff,
  reconcileAllLiveMatches,
} from './services/event-reconciler.js';
import { startQueueConsumers } from './jobs/consumers/index.js';
import { closeQueuePool } from './jobs/supabase-queues.js';

/**
 * Cold-start sequence (section 4):
 *  1. Validate secrets and connect to Supabase.
 *  2. Load/discover the Premier League tournament ID.
 *  3. Sync today's and tomorrow's schedules, filtered by tournament ID.
 *  4. Reconcile currently live matches as a recovery check.
 *  5–6. Open the WebSocket and subscribe to allow-listed match channels.
 *  7. Snapshots feed the same idempotent diff as updates — never direct tweets.
 *  8. Reconnects reload the allow-list and re-run REST reconciliation.
 */
async function startWorker(): Promise<void> {
  const env = loadEnv(); // fails fast on missing/invalid configuration
  initSentry(env);
  logger.info(
    { dryRun: env.DRY_RUN, publishingEnabled: env.PUBLISHING_ENABLED, tone: env.BANTER_TONE },
    'worker starting',
  );

  const competition: Competition = await loadOrDiscoverAndApproveCompetition();

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  await syncSchedule(today.toISOString().slice(0, 10), competition);
  await syncSchedule(tomorrow.toISOString().slice(0, 10), competition);
  await reconcileCurrentlyLive(competition);

  const feed = new SportsFeed({
    onMatchMessage: message =>
      ingestAndDiff({
        matchId: message.matchId,
        kind: message.kind,
        payload: message.payload,
        receivedAt: message.receivedAt,
      }),
    onLiveScores: (payload, allowed, subscribe) =>
      discoverUnexpectedLiveFixture(payload, allowed, subscribe, competition.providerId, competition.id),
    onReconnected: () => reconcileAllLiveMatches(),
  });
  await feed.connect();

  const stopConsumers = startQueueConsumers();
  const stopFixtureSync = startFixtureSyncSchedule(competition);
  const stopApi = await startApiServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    feed.stop();
    stopConsumers();
    stopFixtureSync();
    await stopApi();
    await closeQueuePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('worker ready');
}

void startWorker().catch(error => {
  logger.fatal({ error }, 'worker boot failed');
  process.exitCode = 1;
});
