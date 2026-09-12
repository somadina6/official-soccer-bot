import { MatchEventSchema, type MatchEvent } from '../domain/match-event.js';
import { logger } from '../observability/logger.js';
import { extractIncidents, normalizeIncident } from '../providers/sportsapi/mapper.js';
import { fetchMatchIncidents } from '../providers/sportsapi/rest-client.js';
import { getSupabase } from '../supabase/client.js';

export type ConfirmationResult =
  | { outcome: 'confirmed'; event: MatchEvent }
  | { outcome: 'overturned' }
  | { outcome: 'not_found' };

/**
 * Confirms a pending event after its delay window by re-fetching the match's
 * current incidents from REST (section 5, goal/VAR handling). The event is
 * confirmed only if a matching incident still exists, is not cancelled, and
 * the score still agrees.
 */
export async function confirmEvent(matchEventId: number): Promise<ConfirmationResult> {
  const { data: row, error } = await getSupabase()
    .from('match_events')
    .select('id, normalized, provider_match_id, provider_incident_id, event_type, minute')
    .eq('id', matchEventId)
    .single();
  if (error || !row) throw new Error(`match_event ${matchEventId} not found: ${error?.message}`);

  const stored = MatchEventSchema.parse(row.normalized);

  // FULL_TIME needs no incident-level confirmation beyond its short delay.
  if (stored.type === 'FULL_TIME') return { outcome: 'confirmed', event: stored };

  const payload = await fetchMatchIncidents(String(row.provider_match_id));
  const context = {
    matchId: stored.matchId,
    competitionId: stored.competitionId,
    home: stored.home,
    away: stored.away,
    ...(stored.scoreKnown !== undefined ? { scoreKnown: stored.scoreKnown } : {}),
  };

  for (const raw of extractIncidents(payload)) {
    const current = normalizeIncident(raw, context);
    if (!current) continue;

    const sameIncident = stored.incidentId
      ? current.incidentId === stored.incidentId
      : current.type === stored.type &&
        current.minute === stored.minute &&
        current.player?.name === stored.player?.name;
    if (!sameIncident) continue;

    if (current.status === 'OVERTURNED') return { outcome: 'overturned' };

    const scoreAgrees =
      current.home.score === stored.home.score && current.away.score === stored.away.score;
    if (!scoreAgrees) {
      logger.warn(
        { matchEventId, stored: stored.rawPayloadHash, current: current.rawPayloadHash },
        'score disagreement at confirmation; treating as not confirmed',
      );
      return { outcome: 'not_found' };
    }
    return { outcome: 'confirmed', event: { ...stored, status: 'CONFIRMED' } };
  }

  // The incident vanished from the provider feed within the window.
  return { outcome: 'not_found' };
}
