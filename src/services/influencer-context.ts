import { z } from 'zod';
import type { CompletedMatch, UpcomingFixture, VerifiedResult } from '../domain/influencer.js';
import type { MatchEvent } from '../domain/match-event.js';
import { getSupabase } from '../supabase/client.js';
import {
  fetchProviderMatchStatus,
  isMatchFinished,
  type FixtureMatchStatus,
} from './match-status.js';

const TeamJsonSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    score: z.number().int().optional(),
  })
  .passthrough();

export type InfluencerFixtureRow = {
  id: number;
  provider_match_id: number;
  starts_at: string;
  status: string;
  home_team: unknown;
  away_team: unknown;
};

export function teamNameFromJson(raw: unknown, fallback: string): string {
  const parsed = TeamJsonSchema.safeParse(raw);
  return parsed.success ? (parsed.data.name ?? fallback) : fallback;
}

export function teamScoreFromJson(raw: unknown): number | undefined {
  const parsed = TeamJsonSchema.safeParse(raw);
  return parsed.success && typeof parsed.data.score === 'number' ? parsed.data.score : undefined;
}

export async function loadFixtureById(fixtureId: number): Promise<InfluencerFixtureRow> {
  const { data, error } = await getSupabase()
    .from('fixtures')
    .select('id, provider_match_id, starts_at, status, home_team, away_team')
    .eq('id', fixtureId)
    .single();
  if (error || !data) throw new Error(`fixture ${fixtureId} not found: ${error?.message}`);
  return data as InfluencerFixtureRow;
}

export async function loadFixtureByProviderMatchId(
  providerMatchId: number,
): Promise<InfluencerFixtureRow | null> {
  const { data, error } = await getSupabase()
    .from('fixtures')
    .select('id, provider_match_id, starts_at, status, home_team, away_team')
    .eq('provider', 'sportsapi-pro')
    .eq('provider_match_id', providerMatchId)
    .maybeSingle();
  if (error) throw new Error(`fixture lookup failed: ${error.message}`);
  return data as InfluencerFixtureRow | null;
}

async function hasFullTimeEvent(fixtureId: number): Promise<boolean> {
  const { count, error } = await getSupabase()
    .from('match_events')
    .select('id', { count: 'exact', head: true })
    .eq('fixture_id', fixtureId)
    .eq('event_type', 'FULL_TIME');
  if (error) throw new Error(`full-time lookup failed: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function resolveMatchReadiness(
  fixture: InfluencerFixtureRow,
): Promise<FixtureMatchStatus> {
  if (isMatchFinished(fixture.status, await hasFullTimeEvent(fixture.id))) {
    return 'finished';
  }
  try {
    return await fetchProviderMatchStatus(String(fixture.provider_match_id));
  } catch {
    if (fixture.status === 'live') return 'live';
    return fixture.status === 'scheduled' ? 'scheduled' : 'unknown';
  }
}

async function loadNormalizedEvents(fixtureId: number): Promise<MatchEvent[]> {
  const { data, error } = await getSupabase()
    .from('match_events')
    .select('normalized, event_type')
    .eq('fixture_id', fixtureId)
    .order('occurred_at', { ascending: true });
  if (error) throw new Error(`match_events lookup failed: ${error.message}`);
  return (data ?? [])
    .map(row => row.normalized as MatchEvent)
    .filter(event => event && typeof event === 'object');
}

function scoreFromEvents(
  events: MatchEvent[],
  side: 'home' | 'away',
  fallback: number,
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event) return event[side].score;
  }
  return fallback;
}

export function approvedFactsForMatch(
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  events: MatchEvent[],
): string[] {
  const score = `${home} ${homeScore}–${awayScore} ${away}`;
  const facts = [score, `Full time ${score}`, home, away];
  for (const event of events) {
    if (event.player?.name) {
      facts.push(event.player.name);
      if (event.type === 'GOAL' || event.type === 'OWN_GOAL') {
        facts.push(`${event.player.name} scored at ${event.minute}'`);
      }
      if (event.type === 'RED_CARD') {
        facts.push(`${event.player.name} sent off at ${event.minute}'`);
      }
    }
  }
  return facts;
}

export async function toCompletedMatch(fixture: InfluencerFixtureRow): Promise<CompletedMatch> {
  const events = await loadNormalizedEvents(fixture.id);
  const home = teamNameFromJson(fixture.home_team, 'Home');
  const away = teamNameFromJson(fixture.away_team, 'Away');
  const homeScore = scoreFromEvents(events, 'home', teamScoreFromJson(fixture.home_team) ?? 0);
  const awayScore = scoreFromEvents(events, 'away', teamScoreFromJson(fixture.away_team) ?? 0);
  return {
    fixtureId: String(fixture.id),
    home: { name: home, score: homeScore },
    away: { name: away, score: awayScore },
    events: approvedFactsForMatch(home, away, homeScore, awayScore, events),
  };
}

export function toUpcomingFixture(fixture: InfluencerFixtureRow): UpcomingFixture {
  return {
    fixtureId: String(fixture.id),
    home: { name: teamNameFromJson(fixture.home_team, 'Home') },
    away: { name: teamNameFromJson(fixture.away_team, 'Away') },
    kickoff: fixture.starts_at,
  };
}

export function toVerifiedResult(match: CompletedMatch): VerifiedResult {
  const winner =
    match.home.score === match.away.score
      ? 'draw'
      : match.home.score > match.away.score
        ? match.home.name
        : match.away.name;
  return {
    home: match.home,
    away: match.away,
    winner,
  };
}

export function resultOutcome(
  predictionText: string,
  result: VerifiedResult,
): 'correct' | 'incorrect' | 'unresolved' {
  const lower = predictionText.toLowerCase();
  if (result.winner === 'draw') {
    return /\bdraw\b|\blevel\b|\bshare/.test(lower) ? 'correct' : 'incorrect';
  }
  if (lower.includes(result.winner.toLowerCase())) return 'correct';
  const loser =
    result.winner === result.home.name ? result.away.name : result.home.name;
  if (lower.includes(loser.toLowerCase())) return 'incorrect';
  return 'unresolved';
}
