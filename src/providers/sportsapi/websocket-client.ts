import WebSocket from 'ws';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import { getSupabase } from '../../supabase/client.js';

export type FeedMessage = {
  matchId: string;
  kind: 'snapshot' | 'update';
  channel: string;
  payload: unknown;
  receivedAt: string;
};

export type FeedHandlers = {
  /**
   * Called for every snapshot/update on an allow-listed match channel.
   * Snapshots are reconciliation input, not automatic tweets — only a new
   * normalized incident/revision may create a job downstream.
   * Return `fullTime: true` so the feed unsubscribes `match:{id}` and
   * `match:{id}:incidents`.
   */
  onMatchMessage: (message: FeedMessage) => Promise<{ fullTime: boolean }>;
  /**
   * Called with `live-scores` data so an unexpected/rescheduled live match can
   * be verified via REST, upserted, and then subscribed. Never publish
   * directly from live-scores.
   */
  onLiveScores: (
    payload: unknown,
    allowed: Set<string>,
    subscribe: (matchId: string) => void,
  ) => Promise<void>;
  /**
   * Runs REST reconciliation from the last persisted revision after reconnects.
   * Return any match IDs that are now full-time so their channels are dropped.
   */
  onReconnected: () => Promise<readonly string[]>;
};

/**
 * Match IDs the worker is allowed to process: Premier League fixtures between
 * kick-off minus 60 minutes and roughly full-time plus 30 minutes. Supabase is
 * the durable allow-list; there is no Premier-League-only WebSocket channel.
 */
export async function activeMatchIds(): Promise<Set<string>> {
  const now = Date.now();
  const { data, error } = await getSupabase()
    .from('fixtures')
    .select('provider_match_id')
    .in('status', ['scheduled', 'live'])
    .gte('starts_at', new Date(now - 3 * 60 * 60_000).toISOString())
    .lte('starts_at', new Date(now + 60 * 60_000).toISOString());
  if (error) throw error;
  return new Set((data ?? []).map(row => String(row.provider_match_id)));
}

export class SportsFeed {
  private ws: WebSocket | undefined;
  private allowed = new Set<string>();
  /** Process-lifetime set so live-scores cannot resubscribe a finished match. */
  private finished = new Set<string>();
  private reconnectAttempt = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private hasConnectedBefore = false;

  constructor(private readonly handlers: FeedHandlers) {}

  async connect(): Promise<void> {
    if (this.stopped) return;
    const env = loadEnv();
    this.allowed = await activeMatchIds();
    for (const id of this.finished) this.allowed.add(id);

    logger.info({ matches: this.allowed.size }, 'SportsAPI WebSocket connecting');
    const ws = new WebSocket(env.SPORTSAPI_WS_URL, {
      headers: { 'x-api-key': env.SPORTSAPI_KEY, 'x-sport': 'football' },
    });
    this.ws = ws;

    const send = (action: 'subscribe' | 'unsubscribe' | 'ping', channel: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action, channel }));
    };
    const subscribeMatch = (id: string) => {
      if (this.finished.has(id)) return;
      this.allowed.add(id);
      send('subscribe', `match:${id}`);
      send('subscribe', `match:${id}:incidents`);
    };

    ws.on('open', () => {
      logger.info({ matches: this.allowed.size }, 'sports feed connected');
      this.reconnectAttempt = 0;
      send('subscribe', 'live-scores');
      for (const id of this.allowed) subscribeMatch(id);

      if (this.hasConnectedBefore) {
        void this.handlers
          .onReconnected()
          .then(finishedIds => {
            for (const id of finishedIds) this.unsubscribeMatch(id);
          })
          .catch(err => logger.error({ err }, 'post-reconnect reconciliation failed'));
      }
      this.hasConnectedBefore = true;
    });

    this.heartbeat = setInterval(() => send('ping', 'live-scores'), 30_000);

    ws.on('message', bytes => {
      void (async () => {
        let message: { type?: string; channel?: string; data?: unknown; timestamp?: number };
        try {
          message = JSON.parse(bytes.toString());
        } catch {
          return;
        }
        if (!message.type || !['snapshot', 'update'].includes(message.type)) return;

        if (message.channel === 'live-scores') {
          await this.handlers.onLiveScores(message.data, this.allowed, subscribeMatch);
          return;
        }

        const matchId = /^match:(\d+)/.exec(message.channel ?? '')?.[1];
        if (!matchId || !this.allowed.has(matchId) || this.finished.has(matchId)) return;

        const result = await this.handlers.onMatchMessage({
          matchId,
          kind: message.type as 'snapshot' | 'update',
          channel: message.channel!,
          payload: message.data,
          receivedAt: new Date(message.timestamp ?? Date.now()).toISOString(),
        });
        if (result.fullTime) this.unsubscribeMatch(matchId);
      })().catch(err => logger.error({ err }, 'feed message handling failed'));
    });

    ws.on('error', err => logger.error({ err }, 'sports feed socket error'));

    ws.on('close', () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.stopped) return;
      const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
      const jittered = delay + Math.random() * 500;
      logger.warn({ delayMs: Math.round(jittered) }, 'sports feed closed; reconnecting');
      setTimeout(() => void this.connect(), jittered);
    });
  }

  /** Drops a finished match's channels. Keeps the id allow-listed so live-scores cannot resubscribe it. */
  unsubscribeMatch(matchId: string): void {
    this.allowed.add(matchId);
    if (this.finished.has(matchId)) return;
    this.finished.add(matchId);
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'unsubscribe', channel: `match:${matchId}` }));
      ws.send(JSON.stringify({ action: 'unsubscribe', channel: `match:${matchId}:incidents` }));
    }
    logger.info({ matchId }, 'unsubscribed finished match channels');
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
