import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MatchEvent, MatchEventType } from '../../domain/match-event.js';

/**
 * Provider-payload adapter. This is the single module that understands
 * SportsAPI Pro's payload shapes; everything downstream consumes the stable
 * internal `MatchEvent` schema.
 *
 * Shapes were validated against live Football V2 responses (search, schedule,
 * /live/all, /match/{id}, /match/{id}/incidents). Store
 * `tournament.uniqueTournament.id`, never the per-season `tournament.id`.
 */

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ── Schedule / live extraction ────────────────────────────────────────────────

const TournamentSchema = z
  .object({
    id: z.number(),
    uniqueTournament: z.object({ id: z.number() }).passthrough().optional(),
  })
  .passthrough();

const ScheduledMatchSchema = z.object({
  id: z.number(),
  startTimestamp: z.number(),
  tournament: TournamentSchema,
  homeTeam: z.unknown(),
  awayTeam: z.unknown(),
});

export type ScheduledMatch = z.infer<typeof ScheduledMatchSchema>;

const TeamIdSchema = z.object({ id: z.union([z.number(), z.string()]) }).passthrough();

/** Reads a provider team id from a homeTeam/awayTeam object. */
export function teamIdFromUnknown(team: unknown): number | undefined {
  const parsed = TeamIdSchema.safeParse(team);
  if (!parsed.success) return undefined;
  const id = Number(parsed.data.id);
  return Number.isFinite(id) ? id : undefined;
}

/** Canonical competition id: uniqueTournament.id, falling back to tournament.id. */
export function canonicalTournamentId(match: ScheduledMatch): number {
  return match.tournament.uniqueTournament?.id ?? match.tournament.id;
}

export function matchInvolvesTeam(match: ScheduledMatch, teamIds: Set<number>): boolean {
  if (teamIds.size === 0) return false;
  const home = teamIdFromUnknown(match.homeTeam);
  const away = teamIdFromUnknown(match.awayTeam);
  return (home !== undefined && teamIds.has(home)) || (away !== undefined && teamIds.has(away));
}

export function shouldWatchMatch(
  match: ScheduledMatch,
  premierLeagueTournamentId: number,
  watchedTeamIds: Set<number>,
): boolean {
  return (
    canonicalTournamentId(match) === premierLeagueTournamentId ||
    matchInvolvesTeam(match, watchedTeamIds)
  );
}

/** `/schedule/{date}` uses top-level `events`; `/live/all` nests them under `data`. */
function extractEventList(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.events)) return obj.events;
  if (obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    if (Array.isArray(data.events)) return data.events;
  }
  return [];
}

function parseScheduledMatches(events: unknown[]): ScheduledMatch[] {
  const matches: ScheduledMatch[] = [];
  for (const raw of events) {
    const match = ScheduledMatchSchema.safeParse(raw);
    if (match.success) matches.push(match.data);
  }
  return matches;
}

/** Extracts and validates scheduled matches from a raw `/schedule/{date}` payload. */
export function extractScheduledMatches(payload: unknown): ScheduledMatch[] {
  return parseScheduledMatches(extractEventList(payload));
}

/** Extracts live matches from `/live/all` (full nested events, not the flat `/live` list). */
export function extractLiveMatches(payload: unknown): ScheduledMatch[] {
  return parseScheduledMatches(extractEventList(payload));
}

/**
 * Unwraps `/match/{id}`: the event lives at `match` or `data.event`, not on `data`.
 */
export function extractMatchDetails(payload: unknown): ScheduledMatch | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  const nestedData = obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : undefined;
  for (const candidate of [obj.match, nestedData?.event, obj]) {
    const parsed = ScheduledMatchSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

// ── Incident normalization ───────────────────────────────────────────────────

const PlayerSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string(),
    position: z.string().optional(),
  })
  .passthrough();

const GoalActionSchema = z
  .object({
    eventType: z.string().optional(),
    bodyPart: z.string().optional(),
    situation: z.string().optional(),
    goalMouthLocation: z.string().optional(),
    goalkeeper: z.object({ name: z.string() }).passthrough().optional(),
  })
  .passthrough();

const IncidentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    incidentType: z.string().optional(),
    type: z.string().optional(),
    incidentClass: z.string().optional(),
    text: z.string().optional(),
    time: z.number().optional(),
    minute: z.number().int().optional(),
    addedTime: z.number().int().optional(),
    isHome: z.boolean().optional(),
    reason: z.string().optional(),
    rescinded: z.boolean().optional(),
    isConfirmed: z.boolean().optional(),
    isCancelled: z.boolean().optional(),
    player: PlayerSchema.optional(),
    assist: PlayerSchema.optional(),
    assist1: PlayerSchema.optional(),
    homeScore: z.number().int().optional(),
    awayScore: z.number().int().optional(),
    footballPassingNetworkAction: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type ProviderIncident = z.infer<typeof IncidentSchema>;

/**
 * Identity fields that decide whether two incident payloads are the same
 * publishable event. Volatile extras (passing-network coordinates, market
 * values, userCount) are excluded so live polls do not mint new revisions.
 */
export function canonicalIncidentFingerprint(raw: unknown): Record<string, unknown> {
  const parsed = IncidentSchema.safeParse(raw);
  if (!parsed.success) return { raw };
  const incident = parsed.data;
  const assist = incident.assist1 ?? incident.assist;
  return {
    id: incident.id ?? null,
    incidentType: incident.incidentType ?? incident.type ?? null,
    incidentClass: incident.incidentClass ?? null,
    minute: incident.minute ?? incident.time ?? null,
    isHome: incident.isHome ?? null,
    rescinded: incident.rescinded === true,
    isCancelled: incident.isCancelled === true,
    playerId: incident.player?.id ?? null,
    assistId: assist?.id ?? null,
    homeScore: incident.homeScore ?? null,
    awayScore: incident.awayScore ?? null,
  };
}

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[_\-\s]/g, '');
}

/** Provider incident-type strings mapped into the internal event taxonomy. */
const TYPE_MAP: Record<string, MatchEventType> = {
  goal: 'GOAL',
  owngoal: 'OWN_GOAL',
  redcard: 'RED_CARD',
  red: 'RED_CARD',
  secondyellow: 'RED_CARD',
  yellowred: 'RED_CARD',
  penaltymissed: 'PENALTY_MISSED',
  penaltysaved: 'PENALTY_MISSED',
  missedpenalty: 'PENALTY_MISSED',
  var: 'VAR',
  vardecision: 'VAR',
  fulltime: 'FULL_TIME',
  matchended: 'FULL_TIME',
};

function mapIncidentType(incident: ProviderIncident): MatchEventType | null {
  const rawType = compactKey(incident.incidentType ?? incident.type ?? '');
  const klass = compactKey(incident.incidentClass ?? '');
  const text = (incident.text ?? '').trim().toLowerCase();

  if (rawType === 'goal' || rawType === 'owngoal') {
    return rawType === 'owngoal' || klass === 'owngoal' ? 'OWN_GOAL' : 'GOAL';
  }
  if (rawType === 'card') {
    if (klass === 'red' || klass === 'yellowred' || klass === 'secondyellow') return 'RED_CARD';
    return null;
  }
  if (rawType === 'period') {
    if (text === 'ft' || text === 'full time' || text === 'full-time' || text === 'ended') {
      return 'FULL_TIME';
    }
    return null;
  }
  return TYPE_MAP[rawType] ?? null;
}

export type MatchContext = {
  matchId: string;
  competitionId: string;
  home: { id: string; name: string; score: number; colours: string[] };
  away: { id: string; name: string; score: number; colours: string[] };
};

const ADDED_TIME_SENTINEL = 999;

/**
 * Normalizes one provider incident into a `MatchEvent`, or null when the
 * incident type is outside the publishing taxonomy (e.g. yellow cards and
 * routine substitutions, which are disabled by default).
 */
export function normalizeIncident(raw: unknown, context: MatchContext): MatchEvent | null {
  const parsed = IncidentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const incident = parsed.data;

  const type = mapIncidentType(incident);
  if (!type) return null;

  const home = { ...context.home };
  const away = { ...context.away };
  if (incident.homeScore !== undefined) home.score = incident.homeScore;
  if (incident.awayScore !== undefined) away.score = incident.awayScore;

  const minute = Math.max(0, Math.trunc(incident.minute ?? incident.time ?? 0));
  const assist = incident.assist1 ?? incident.assist;
  const overturned = incident.rescinded === true || incident.isCancelled === true;

  const event: MatchEvent = {
    provider: 'sportsapi-pro',
    matchId: context.matchId,
    competitionId: context.competitionId,
    type,
    status: overturned ? 'OVERTURNED' : incident.isConfirmed ? 'CONFIRMED' : 'PROVISIONAL',
    minute,
    occurredAt: new Date().toISOString(),
    home,
    away,
    rawPayloadHash: hashPayload(canonicalIncidentFingerprint(raw)),
  };

  if (incident.id !== undefined) event.incidentId = String(incident.id);
  if (
    incident.addedTime !== undefined &&
    incident.addedTime >= 0 &&
    incident.addedTime < ADDED_TIME_SENTINEL
  ) {
    event.stoppageMinute = incident.addedTime;
  }
  if (incident.player) {
    event.player = incident.player.id !== undefined
      ? { id: String(incident.player.id), name: incident.player.name }
      : { name: incident.player.name };
  }
  if (assist) {
    event.assist = assist.id !== undefined
      ? { id: String(assist.id), name: assist.name }
      : { name: assist.name };
  }
  return event;
}

/** Extracts the raw incident list from REST or WebSocket incident payloads. */
export function extractIncidents(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.incidents)) return obj.incidents;
  if (obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    if (Array.isArray(data.incidents)) return data.incidents;
  }
  return [];
}

const POSITION_LABEL: Record<string, string> = {
  d: 'defender',
  m: 'midfielder',
  f: 'forward',
  g: 'goalkeeper',
};

/** Drops anything with digits so commentary validation will not see extra numbers. */
function digitFreePhrase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!text || text.length > 48 || /\d/.test(text)) return undefined;
  return text.toLowerCase();
}

function lastGoalAction(network: unknown[] | undefined) {
  if (!network) return undefined;
  for (let i = network.length - 1; i >= 0; i--) {
    const parsed = GoalActionSchema.safeParse(network[i]);
    if (parsed.success && parsed.data.eventType === 'goal') return parsed.data;
  }
  return undefined;
}

/**
 * Whitelisted, digit-free facts from a raw incident for the commentary
 * context dictionary. Coordinates, jersey numbers, market values and
 * passing-network teammates are omitted.
 */
export function extractApprovedIncidentFacts(raw: unknown): string[] {
  const parsed = IncidentSchema.safeParse(raw);
  if (!parsed.success) return [];
  const incident = parsed.data;
  const facts: string[] = [];

  const rawType = compactKey(incident.incidentType ?? incident.type ?? '');
  if (rawType === 'goal' || rawType === 'owngoal') {
    if (incident.isHome === true) facts.push('scored by the home team');
    else if (incident.isHome === false) facts.push('scored by the away team');
  }

  if (rawType === 'penaltysaved' || rawType === 'savedpenalty') {
    facts.push('penalty saved');
  } else if (rawType === 'penaltymissed' || rawType === 'missedpenalty') {
    facts.push('penalty missed');
  }

  const klass = compactKey(incident.incidentClass ?? '');
  if (klass === 'regular') facts.push('from open play');
  else if (klass === 'penalty') facts.push('from a penalty');

  const position = POSITION_LABEL[compactKey(incident.player?.position ?? '')];
  if (position) facts.push(`player is a ${position}`);

  const reason = digitFreePhrase(incident.reason);
  if (reason) facts.push(reason);

  const goal = lastGoalAction(incident.footballPassingNetworkAction);
  const bodyPart = digitFreePhrase(goal?.bodyPart);
  if (bodyPart) facts.push(bodyPart);
  const placement = digitFreePhrase(goal?.goalMouthLocation);
  if (placement) facts.push(placement);
  const situation = digitFreePhrase(goal?.situation);
  if (situation === 'assisted') facts.push('assisted');
  const keeper = digitFreePhrase(goal?.goalkeeper?.name);
  if (keeper) facts.push(`goalkeeper ${goal!.goalkeeper!.name}`);

  return [...new Set(facts)];
}

// ── Season statistics ──────────────────────────────────────────────────────

const SeasonEntrySchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    year: z.union([z.number(), z.string()]).optional(),
    tournament: z.object({ id: z.union([z.number(), z.string()]) }).passthrough().optional(),
    uniqueTournament: z.object({ id: z.union([z.number(), z.string()]) }).passthrough().optional(),
  })
  .passthrough();

const SeasonListSchema = z.array(SeasonEntrySchema);
const SeasonsDataEnvelopeSchema = z.object({ data: SeasonListSchema }).passthrough();
const SeasonsSeasonsEnvelopeSchema = z.object({ seasons: SeasonListSchema }).passthrough();

/**
 * Picks the season id matching a tournament from a `/statistics/seasons`
 * payload. Returns undefined (never throws) when the shape doesn't match or
 * no season lines up with the given tournament.
 */
export function resolveSeasonId(raw: unknown, tournamentId: string): string | undefined {
  const list = SeasonListSchema.safeParse(raw);
  const dataEnvelope = list.success ? undefined : SeasonsDataEnvelopeSchema.safeParse(raw);
  const seasonsEnvelope = dataEnvelope?.success
    ? undefined
    : SeasonsSeasonsEnvelopeSchema.safeParse(raw);

  const entries = list.success
    ? list.data
    : dataEnvelope?.success
      ? dataEnvelope.data.data
      : seasonsEnvelope?.success
        ? seasonsEnvelope.data.seasons
        : undefined;
  if (!entries) return undefined;

  const match = entries.find(
    entry =>
      String(entry.tournament?.id ?? '') === tournamentId ||
      String(entry.uniqueTournament?.id ?? '') === tournamentId,
  );
  return match ? String(match.id) : undefined;
}

const SeasonStatisticsSchema = z
  .object({
    goals: z.number().optional(),
    assists: z.number().optional(),
  })
  .passthrough();

function unwrapSeasonStatistics(raw: unknown): z.infer<typeof SeasonStatisticsSchema> | undefined {
  for (const candidate of [
    raw,
    (raw as { data?: unknown } | null)?.data,
    (raw as { statistics?: unknown } | null)?.statistics,
  ]) {
    const parsed = SeasonStatisticsSchema.safeParse(candidate);
    if (parsed.success && (parsed.data.goals !== undefined || parsed.data.assists !== undefined)) {
      return parsed.data;
    }
  }
  return undefined;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Whitelisted, milestone-only facts from a player's season statistics.
 * Only goal/assist totals are surfaced (as ordinal season counts) — every
 * other field (shots, passes, cards, rating, ...) is intentionally dropped
 * to keep this bot's voice from turning into a stat dump.
 */
export function extractApprovedSeasonFacts(raw: unknown): string[] {
  const stats = unwrapSeasonStatistics(raw);
  if (!stats) return [];
  const facts: string[] = [];
  if (stats.goals !== undefined && stats.goals > 0) {
    facts.push(`${ordinal(stats.goals)} goal of the season`);
  }
  if (stats.assists !== undefined && stats.assists > 0) {
    facts.push(`${ordinal(stats.assists)} assist of the season`);
  }
  return facts;
}
