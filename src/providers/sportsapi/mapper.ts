import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MatchEvent, MatchEventType } from '../../domain/match-event.js';

/**
 * Provider-payload adapter. This is the single module that understands
 * SportsAPI Pro's payload shapes; everything downstream consumes the stable
 * internal `MatchEvent` schema.
 *
 * Phase 0/2 requirement: validate these schemas against recorded live
 * responses and add fixtures for goals, own goals, red cards, VAR reversals
 * and full time before trusting them in production.
 */

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ── Schedule extraction ───────────────────────────────────────────────────────

const ScheduledMatchSchema = z.object({
  id: z.number(),
  startTimestamp: z.number(),
  tournament: z.object({ id: z.number() }),
  homeTeam: z.unknown(),
  awayTeam: z.unknown(),
});

export type ScheduledMatch = z.infer<typeof ScheduledMatchSchema>;

const SchedulePayloadSchema = z.object({
  data: z.object({
    // The schedule endpoint groups the date by tournament; each group carries
    // its matches. Unknown groups are tolerated and skipped.
    tournaments: z
      .array(z.object({ matches: z.array(z.unknown()).default([]) }))
      .default([]),
  }),
});

/** Extracts and validates scheduled matches from a raw schedule payload. */
export function extractScheduledMatches(payload: unknown): ScheduledMatch[] {
  const parsed = SchedulePayloadSchema.safeParse(payload);
  if (!parsed.success) return [];

  const matches: ScheduledMatch[] = [];
  for (const group of parsed.data.data.tournaments) {
    for (const raw of group.matches) {
      const match = ScheduledMatchSchema.safeParse(raw);
      if (match.success) matches.push(match.data);
    }
  }
  return matches;
}

// ── Live match extraction (recovery path) ────────────────────────────────────

const LiveMatchSchema = z.object({
  id: z.number(),
  startTimestamp: z.number(),
  tournament: z.object({ id: z.number() }),
  homeTeam: z.unknown(),
  awayTeam: z.unknown(),
});

const LivePayloadSchema = z.object({
  data: z.object({ matches: z.array(z.unknown()).default([]) }),
});

export function extractLiveMatches(payload: unknown): ScheduledMatch[] {
  const parsed = LivePayloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.data.matches
    .map(raw => LiveMatchSchema.safeParse(raw))
    .filter(result => result.success)
    .map(result => result.data);
}

// ── Incident normalization ───────────────────────────────────────────────────

const IncidentSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string(),
  minute: z.number().int().default(0),
  addedTime: z.number().int().optional(),
  time: z.number().optional(), // unix seconds when the incident occurred
  isConfirmed: z.boolean().optional(),
  isCancelled: z.boolean().optional(),
  player: z.object({ id: z.union([z.string(), z.number()]).optional(), name: z.string() }).optional(),
  assist: z.object({ id: z.union([z.string(), z.number()]).optional(), name: z.string() }).optional(),
  homeScore: z.number().int().optional(),
  awayScore: z.number().int().optional(),
});

export type ProviderIncident = z.infer<typeof IncidentSchema>;

/** Provider incident-type strings mapped into the internal event taxonomy. */
const TYPE_MAP: Record<string, MatchEventType> = {
  goal: 'GOAL',
  own_goal: 'OWN_GOAL',
  owngoal: 'OWN_GOAL',
  red_card: 'RED_CARD',
  redcard: 'RED_CARD',
  second_yellow: 'RED_CARD',
  penalty_missed: 'PENALTY_MISSED',
  penalty_saved: 'PENALTY_MISSED',
  var: 'VAR',
  var_decision: 'VAR',
  full_time: 'FULL_TIME',
  match_ended: 'FULL_TIME',
};

export type MatchContext = {
  matchId: string;
  competitionId: string;
  home: { id: string; name: string; score: number; colours: string[] };
  away: { id: string; name: string; score: number; colours: string[] };
};

/**
 * Normalizes one provider incident into a `MatchEvent`, or null when the
 * incident type is outside the publishing taxonomy (e.g. yellow cards and
 * routine substitutions, which are disabled by default).
 */
export function normalizeIncident(raw: unknown, context: MatchContext): MatchEvent | null {
  const parsed = IncidentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const incident = parsed.data;

  const type = TYPE_MAP[incident.type.toLowerCase()];
  if (!type) return null;

  const home = { ...context.home };
  const away = { ...context.away };
  if (incident.homeScore !== undefined) home.score = incident.homeScore;
  if (incident.awayScore !== undefined) away.score = incident.awayScore;

  const event: MatchEvent = {
    provider: 'sportsapi-pro',
    matchId: context.matchId,
    competitionId: context.competitionId,
    type,
    status: incident.isCancelled ? 'OVERTURNED' : incident.isConfirmed ? 'CONFIRMED' : 'PROVISIONAL',
    minute: incident.minute,
    occurredAt: new Date((incident.time ?? Date.now() / 1000) * 1000).toISOString(),
    home,
    away,
    rawPayloadHash: hashPayload(raw),
  };

  if (incident.id !== undefined) event.incidentId = String(incident.id);
  if (incident.addedTime !== undefined) event.stoppageMinute = incident.addedTime;
  if (incident.player) {
    event.player = incident.player.id !== undefined
      ? { id: String(incident.player.id), name: incident.player.name }
      : { name: incident.player.name };
  }
  if (incident.assist) {
    event.assist = incident.assist.id !== undefined
      ? { id: String(incident.assist.id), name: incident.assist.name }
      : { name: incident.assist.name };
  }
  return event;
}

const IncidentsPayloadSchema = z.object({
  data: z.object({ incidents: z.array(z.unknown()).default([]) }),
});

/** Extracts the raw incident list from a `/match/{id}/incidents` payload. */
export function extractIncidents(payload: unknown): unknown[] {
  const parsed = IncidentsPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.data.incidents : [];
}
