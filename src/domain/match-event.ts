import { z } from 'zod';

/** Event lifecycle states (section 5 of the plan). */
export const EVENT_STATES = [
  'RECEIVED',
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'GENERATING',
  'VALIDATED',
  'PUBLISHING',
  'PUBLISHED',
  // terminal alternatives
  'IGNORED',
  'OVERTURNED',
  'FAILED',
  'MANUAL_REVIEW',
] as const;

export type EventState = (typeof EVENT_STATES)[number];

export const MatchEventTypeSchema = z.enum([
  'GOAL',
  'OWN_GOAL',
  'RED_CARD',
  'PENALTY_MISSED',
  'VAR',
  'FULL_TIME',
]);
export type MatchEventType = z.infer<typeof MatchEventTypeSchema>;

const TeamSideSchema = z.object({
  id: z.string(),
  name: z.string(),
  score: z.number().int().min(0),
  colours: z.array(z.string()),
});

export const MatchEventSchema = z.object({
  provider: z.literal('sportsapi-pro'),
  matchId: z.string(),
  incidentId: z.string().optional(),
  competitionId: z.string(),
  type: MatchEventTypeSchema,
  status: z.enum(['PROVISIONAL', 'CONFIRMED', 'OVERTURNED']),
  minute: z.number().int().min(0),
  stoppageMinute: z.number().int().min(0).optional(),
  occurredAt: z.string(),
  home: TeamSideSchema,
  away: TeamSideSchema,
  player: z.object({ id: z.string().optional(), name: z.string() }).optional(),
  assist: z.object({ id: z.string().optional(), name: z.string() }).optional(),
  rawPayloadHash: z.string(),
});

export type MatchEvent = z.infer<typeof MatchEventSchema>;

/**
 * Deterministic idempotency key. A unique Postgres constraint on this key
 * plus its inclusion in every queue message guarantees at-most-once posting
 * per provider revision.
 */
export function buildIdempotencyKey(event: MatchEvent, revision: number): string {
  return [
    event.provider,
    event.matchId,
    event.incidentId ?? `${event.minute}:${event.type}:${event.player?.id ?? 'unknown'}`,
    revision,
  ].join(':');
}
