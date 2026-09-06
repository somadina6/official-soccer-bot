import type { EventState, MatchEvent } from '../domain/match-event.js';
import type { FullTimeScorer } from './visual-composer.js';
import { getSupabase } from '../supabase/client.js';

/** Any state reachable only after confirmation, i.e. never rejected/overturned/unconfirmed. */
const CONFIRMED_ONWARD_STATES: EventState[] = [
  'CONFIRMED',
  'GENERATING',
  'VALIDATED',
  'PUBLISHING',
  'PUBLISHED',
];

export type ScorerRow = {
  event_type: 'GOAL' | 'OWN_GOAL';
  minute: number;
  stoppage_minute: number | null;
  normalized: MatchEvent;
};

function sortKey(row: ScorerRow): number {
  return row.minute * 1000 + (row.stoppage_minute ?? 0);
}

/**
 * Pure derivation, split out from loadFullTimeScorers for testability: turns
 * stored GOAL/OWN_GOAL rows into a minute-ordered scorers list, each credited
 * to the side its goal counted toward — broadcast convention credits an own
 * goal to the side it benefits, not the scorer's own team. Derived by
 * comparing each goal's cumulative score to the one before it, since the
 * stored event doesn't say which side the score change belongs to.
 */
export function deriveFullTimeScorers(rows: readonly ScorerRow[]): FullTimeScorer[] {
  const sorted = rows.slice().sort((a, b) => sortKey(a) - sortKey(b));

  let priorHome = 0;
  let priorAway = 0;
  const scorers: FullTimeScorer[] = [];
  for (const row of sorted) {
    const event = row.normalized;
    const name = event?.player?.name;

    // Track the running score against every row, named or not, so a row
    // with no scorer name never causes the *next* row to be misread as a
    // fresh increase against a stale prior score.
    const side =
      event.home.score > priorHome ? 'home' : event.away.score > priorAway ? 'away' : undefined;
    priorHome = event.home.score;
    priorAway = event.away.score;
    if (!name || !side) continue;

    scorers.push({
      name,
      minute: row.minute,
      stoppageMinute: row.stoppage_minute ?? undefined,
      side,
      ownGoal: row.event_type === 'OWN_GOAL',
    });
  }
  return scorers;
}

/** Confirmed goal-scorers for a match, ready to draw on the full-time image (see deriveFullTimeScorers). */
export async function loadFullTimeScorers(fixtureId: number): Promise<FullTimeScorer[]> {
  const { data, error } = await getSupabase()
    .from('match_events')
    .select('event_type, minute, stoppage_minute, normalized')
    .eq('fixture_id', fixtureId)
    .in('event_type', ['GOAL', 'OWN_GOAL'])
    .in('state', CONFIRMED_ONWARD_STATES);
  if (error) throw new Error(`scorers lookup failed: ${error.message}`);

  return deriveFullTimeScorers((data ?? []) as ScorerRow[]);
}
