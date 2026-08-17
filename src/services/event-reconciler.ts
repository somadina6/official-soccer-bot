import { z } from 'zod';
import type { MatchEvent } from '../domain/match-event.js';
import { logger } from '../observability/logger.js';
import {
  canonicalTournamentId,
  extractIncidents,
  extractMatchDetails,
  normalizeIncident,
  teamIdFromUnknown,
  type MatchContext,
} from '../providers/sportsapi/mapper.js';
import { fetchMatch, fetchMatchIncidents } from '../providers/sportsapi/rest-client.js';
import { getSupabase } from '../supabase/client.js';
import { QUEUES, sendToQueue } from '../jobs/supabase-queues.js';
import { evaluateEligibility } from './eligibility.js';
import { loadRuntimeSettings } from './settings.js';
import { loadWatchedTeamIds } from './watched-clubs.js';

/** Tolerant reader for the team JSON stored on fixtures. */
const TeamJsonSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    score: z.number().int().optional(),
    colours: z.array(z.string()).optional(),
    colors: z.object({ primary: z.string().optional(), secondary: z.string().optional() }).optional(),
    teamColors: z.object({ primary: z.string().optional(), secondary: z.string().optional() }).optional(),
  })
  .passthrough();

function toTeamSide(raw: unknown, fallbackName: string) {
  const parsed = TeamJsonSchema.safeParse(raw);
  const team = parsed.success ? parsed.data : {};
  const colours =
    team.colours ??
    [team.teamColors?.primary, team.teamColors?.secondary, team.colors?.primary, team.colors?.secondary].filter(
      (c): c is string => Boolean(c),
    );
  return {
    id: team.id !== undefined ? String(team.id) : 'unknown',
    name: team.name ?? fallbackName,
    score: team.score ?? 0,
    colours,
  };
}

type FixtureRow = {
  id: number;
  competition_id: number;
  provider_match_id: number;
  home_team: unknown;
  away_team: unknown;
  status: string;
};

async function loadFixture(matchId: string): Promise<FixtureRow | null> {
  const { data, error } = await getSupabase()
    .from('fixtures')
    .select('id, competition_id, provider_match_id, home_team, away_team, status')
    .eq('provider', 'sportsapi-pro')
    .eq('provider_match_id', Number(matchId))
    .maybeSingle();
  if (error) throw new Error(`fixture lookup failed: ${error.message}`);
  return data as FixtureRow | null;
}

function buildContext(matchId: string, fixture: FixtureRow): MatchContext {
  return {
    matchId,
    competitionId: String(fixture.competition_id),
    home: toTeamSide(fixture.home_team, 'Home'),
    away: toTeamSide(fixture.away_team, 'Away'),
  };
}

/** Natural key for an incident, before the revision suffix. */
function naturalKey(event: MatchEvent): string {
  return [
    event.provider,
    event.matchId,
    event.incidentId ?? `${event.minute}:${event.type}:${event.player?.id ?? 'unknown'}`,
  ].join(':');
}

const IN_FLIGHT_STATES = new Set([
  'RECEIVED',
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'GENERATING',
  'VALIDATED',
  'PUBLISHING',
  'PUBLISHED',
]);

export type ExistingIngestRow = {
  revision: number;
  raw_payload_hash: string;
  state: string;
};

/**
 * Skip a new revision when this incident was already seen, or is already
 * progressing toward a post. Overturns always create a revision so corrections
 * can run.
 */
export function shouldSkipDuplicateIngest(
  existing: ExistingIngestRow[],
  incomingHash: string,
  incomingStatus: MatchEvent['status'],
): boolean {
  if (existing.some(row => row.raw_payload_hash === incomingHash)) return true;
  const latest = existing[0];
  if (!latest) return false;
  if (incomingStatus === 'OVERTURNED') return false;
  return IN_FLIGHT_STATES.has(latest.state);
}

/**
 * Ingests one normalized event idempotently.
 *
 * - Same natural key + same canonical hash → duplicate, ignored (including
 *   an earlier revision whose hash later reappears).
 * - Same incident already in flight / published → ignored unless overturned.
 * - Overturned status → new revision routed to corrections.
 */
async function ingestEvent(event: MatchEvent, fixture: FixtureRow, rawPayload: unknown): Promise<void> {
  const supabase = getSupabase();
  const key = naturalKey(event);

  const { data: existing, error: lookupError } = await supabase
    .from('match_events')
    .select('id, revision, raw_payload_hash, state')
    .like('idempotency_key', `${key}:%`)
    .order('revision', { ascending: false });
  if (lookupError) throw new Error(`event lookup failed: ${lookupError.message}`);

  const rows = (existing ?? []) as ExistingIngestRow[];
  if (shouldSkipDuplicateIngest(rows, event.rawPayloadHash, event.status)) {
    logger.debug({ key, status: event.status }, 'duplicate incident ignored');
    return;
  }

  const latest = rows[0];
  const revision = latest ? latest.revision + 1 : 0;
  const idempotencyKey = `${key}:${revision}`;

  const { data: inserted, error: insertError } = await supabase
    .from('match_events')
    .insert({
      idempotency_key: idempotencyKey,
      fixture_id: fixture.id,
      provider: event.provider,
      provider_match_id: fixture.provider_match_id,
      provider_incident_id: event.incidentId ?? null,
      event_type: event.type,
      state: 'RECEIVED',
      minute: event.minute,
      stoppage_minute: event.stoppageMinute ?? null,
      occurred_at: event.occurredAt,
      normalized: event,
      raw_payload: rawPayload as never,
      raw_payload_hash: event.rawPayloadHash,
      revision,
    })
    .select('id')
    .single();

  if (insertError) {
    // Unique violation on idempotency_key = concurrent duplicate; safe to skip.
    if (insertError.code === '23505') return;
    throw new Error(`event insert failed: ${insertError.message}`);
  }

  await supabase.from('event_revisions').insert({
    match_event_id: inserted.id,
    revision,
    raw_payload: rawPayload as never,
    raw_payload_hash: event.rawPayloadHash,
  });

  // An overturn of a previously published goal goes to the corrections queue.
  if (event.status === 'OVERTURNED' && latest) {
    await supabase.from('match_events').update({ state: 'OVERTURNED', updated_at: new Date().toISOString() }).eq('id', inserted.id);
    await sendToQueue(QUEUES.postCorrections, {
      idempotencyKey,
      matchEventId: inserted.id,
      overturnedNaturalKey: key,
    });
    logger.warn({ idempotencyKey }, 'overturned event routed to corrections');
    return;
  }

  const settings = await loadRuntimeSettings();
  const decision = evaluateEligibility(event, settings);
  if (!decision.eligible) {
    await supabase
      .from('match_events')
      .update({ state: 'IGNORED', updated_at: new Date().toISOString() })
      .eq('id', inserted.id);
    logger.debug({ idempotencyKey, reason: decision.reason }, 'event ignored');
    return;
  }

  await supabase
    .from('match_events')
    .update({ state: 'PENDING_CONFIRMATION', updated_at: new Date().toISOString() })
    .eq('id', inserted.id);
  await sendToQueue(
    QUEUES.eventConfirmation,
    { idempotencyKey, matchEventId: inserted.id },
    decision.confirmationDelaySeconds,
  );
  logger.info(
    { idempotencyKey, type: event.type, delay: decision.confirmationDelaySeconds },
    'event queued for confirmation',
  );
}

export type IngestInput = {
  matchId: string;
  kind: 'snapshot' | 'update';
  payload: unknown;
  receivedAt: string;
};

/**
 * Entry point for both WebSocket messages and REST reconciliation payloads.
 * Snapshots pass through the same idempotent diff, so a resent snapshot never
 * creates a duplicate job.
 */
export async function ingestAndDiff(input: IngestInput): Promise<void> {
  logger.info({ matchId: input.matchId }, 'ingestAndDiff started');
  
  const fixture = await loadFixture(input.matchId);
  if (!fixture) {
    logger.warn({ matchId: input.matchId }, 'message for unknown fixture ignored');
    return;
  }
  const context = buildContext(input.matchId, fixture);

  const rawIncidents = extractIncidents(input.payload);
  // Some channels send a single incident object rather than a list.
  const candidates = rawIncidents.length > 0 ? rawIncidents : [input.payload];

  for (const raw of candidates) {
    const event = normalizeIncident(raw, context);
    if (!event) continue;
    await ingestEvent(event, fixture, raw);

    if (event.type === 'FULL_TIME') {
      await getSupabase()
        .from('fixtures')
        .update({ status: 'finished', updated_at: new Date().toISOString() })
        .eq('id', fixture.id);
    }
  }
}

/** REST reconciliation for one match: used after reconnects, suspicious score
 * changes and the final whistle so no event is missed. */
export async function reconcileMatchFromRest(matchId: string): Promise<void> {
  const payload = await fetchMatchIncidents(matchId);
  await ingestAndDiff({
    matchId,
    kind: 'snapshot',
    payload,
    receivedAt: new Date().toISOString(),
  });
}

/** Reconciles every fixture currently marked live. */
export async function reconcileAllLiveMatches(): Promise<void> {
  const { data, error } = await getSupabase()
    .from('fixtures')
    .select('provider_match_id')
    .eq('status', 'live');
  if (error) throw new Error(`live fixture query failed: ${error.message}`);
  for (const row of data ?? []) {
    await reconcileMatchFromRest(String(row.provider_match_id)).catch(err =>
      logger.error({ err, matchId: row.provider_match_id }, 'match reconciliation failed'),
    );
  }
}

const LiveScoresEntrySchema = z.object({ id: z.union([z.string(), z.number()]) }).passthrough();

/**
 * Handles `live-scores` data: detects a live match missing from the
 * allow-list, verifies it is Premier League or involves a watched club,
 * upserts the fixture and subscribes to its channels. Nothing is ever
 * published directly from live-scores.
 */
export async function discoverUnexpectedLiveFixture(
  payload: unknown,
  allowed: Set<string>,
  subscribe: (matchId: string) => void,
  premierLeagueTournamentId: number,
  competitionRowId: number,
): Promise<void> {
  const entries = Array.isArray(payload) ? payload : [payload];
  const watchedTeamIds = await loadWatchedTeamIds();
  for (const entry of entries) {
    const parsed = LiveScoresEntrySchema.safeParse(entry);
    if (!parsed.success) continue;
    const matchId = String(parsed.data.id);
    if (allowed.has(matchId)) continue;

    let match: ReturnType<typeof extractMatchDetails>;
    try {
      match = extractMatchDetails(await fetchMatch(matchId));
    } catch {
      continue;
    }
    if (!match) continue;
    const homeId = teamIdFromUnknown(match.homeTeam);
    const awayId = teamIdFromUnknown(match.awayTeam);
    const isPremierLeague = canonicalTournamentId(match) === premierLeagueTournamentId;
    const isWatchedClub =
      (homeId !== undefined && watchedTeamIds.has(homeId)) ||
      (awayId !== undefined && watchedTeamIds.has(awayId));
    if (!isPremierLeague && !isWatchedClub) continue;

    const { error } = await getSupabase().from('fixtures').upsert(
      {
        provider: 'sportsapi-pro',
        provider_match_id: Number(matchId),
        competition_id: competitionRowId,
        starts_at: new Date((match.startTimestamp ?? Date.now() / 1000) * 1000).toISOString(),
        status: 'live',
        home_team: match.homeTeam ?? {},
        away_team: match.awayTeam ?? {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'provider,provider_match_id' },
    );
    if (error) {
      logger.error({ matchId, error: error.message }, 'unexpected live fixture upsert failed');
      continue;
    }
    subscribe(matchId);
    logger.info(
      { matchId, isPremierLeague, isWatchedClub },
      'unexpected live fixture discovered and subscribed',
    );
  }
}
