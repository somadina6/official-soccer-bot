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
import { discoverWatchedClubs } from './services/watched-clubs.js';
import { ingestAndDiff, reconcileAllLiveMatches } from './services/event-reconciler.js';
import { startQueueConsumers } from './jobs/consumers/index.js';
import { closeQueuePool } from './jobs/supabase-queues.js';

async function trySportsStep(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.warn({ error, step: label }, 'SportsAPI boot step failed; continuing without it');
  }
}

/**
 * Cold-start sequence (section 4):
 *  1. Validate secrets and connect to Supabase.
 *  2. Load/discover the Premier League tournament ID.
 *  3. Sync today's and tomorrow's schedules (Premier League + watched clubs).
 *  4. Reconcile currently live matches as a recovery check.
 *  5–6. Open the WebSocket and subscribe to allow-listed match channels.
 *  7. Snapshots feed the same idempotent diff as updates — never direct tweets.
 *  8. Reconnects reload the allow-list and re-run REST reconciliation.
 *  9. Allow-list is refreshed from Supabase on a timer and after each fixture sync.
 *
 * Schedule/live/websocket failures are logged, not fatal, so queue consumers
 * still start (seed + commentary + dry-run do not need SportsAPI).
 * SPORTSAPI_ENABLED=false skips those calls entirely (e.g. during a 429).
 */
async function startWorker(): Promise<void> {
  const env = loadEnv();
  initSentry(env);
  logger.info(
    {
      dryRun: env.DRY_RUN,
      publishingEnabled: env.PUBLISHING_ENABLED,
      tone: env.BANTER_TONE,
      sportsApiEnabled: env.SPORTSAPI_ENABLED,
    },
    'worker starting',
  );

  const competition: Competition = await loadOrDiscoverAndApproveCompetition();
  await discoverWatchedClubs();

  let feed: SportsFeed | undefined;
  let stopFixtureSync = () => {};

  if (env.SPORTSAPI_ENABLED) {
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    await trySportsStep('sync-today', () =>
      syncSchedule(today.toISOString().slice(0, 10), competition),
    );
    await trySportsStep('sync-tomorrow', () =>
      syncSchedule(tomorrow.toISOString().slice(0, 10), competition),
    );
    await trySportsStep('reconcile-live', () => reconcileCurrentlyLive(competition));

    feed = new SportsFeed({
      onMatchMessage: message =>
        ingestAndDiff({
          matchId: message.matchId,
          kind: message.kind,
          payload: message.payload,
          receivedAt: message.receivedAt,
        }),
      onReconnected: () => reconcileAllLiveMatches(),
    });
    await trySportsStep('websocket', () => feed!.connect());
    stopFixtureSync = startFixtureSyncSchedule(competition, () => feed!.refreshAllowList());
  } else {
    logger.warn('SPORTSAPI_ENABLED=false; skipping schedule, live reconcile, and websocket');
  }

  const stopConsumers = startQueueConsumers();
  const stopApi = await startApiServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    feed?.stop();
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
  console.error(error);
  logger.fatal({ error }, 'worker boot failed');
  process.exitCode = 1;
});
