import { loadEnv } from '../../config/env.js';

/**
 * SportsAPI Pro Football V2 REST client. Paths and `x-api-key` authentication
 * follow the provider's official JavaScript examples.
 */
async function sportsGet<T>(path: string): Promise<T> {
  const env = loadEnv();
  const response = await fetch(`${env.SPORTSAPI_BASE_URL}${path}`, {
    headers: { 'x-api-key': env.SPORTSAPI_KEY },
  });
  if (!response.ok) throw new Error(`SportsAPI ${response.status}: ${path}`);
  return response.json() as Promise<T>;
}

export type SearchResponse = {
  data: {
    results: Array<{
      type: string;
      entity: {
        id: number;
        name: string;
        slug?: string;
        gender?: string;
        country?: { name?: string };
        category?: { name?: string; country?: { name?: string } };
      };
    }>;
  };
};

function tournamentCountry(entity: SearchResponse['data']['results'][number]['entity']): string {
  return (
    entity.category?.country?.name ??
    entity.category?.name ??
    entity.country?.name ??
    ''
  ).toLowerCase();
}

/**
 * Discovers the English Premier League tournament ID via search. Entity IDs
 * must be discovered dynamically, never hardcoded. Throws when the match is
 * not unique so an operator can review the candidates (youth/women's leagues
 * and similarly named tournaments exist).
 */
export async function discoverPremierLeagueId(): Promise<{
  id: number;
  candidates: SearchResponse['data']['results'];
}> {
  const result = await sportsGet<SearchResponse>(
    '/search?q=' + encodeURIComponent('premier league'),
  );
  const candidates = result.data.results.filter(({ type, entity }) => {
    const isTournament = type === 'uniqueTournament' || type === 'tournament';
    return (
      isTournament &&
      entity.name.toLowerCase() === 'premier league' &&
      tournamentCountry(entity) === 'england'
    );
  });

  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one English Premier League tournament; found ${candidates.length}. ` +
        'Manual review required before storing a provider tournament ID.',
    );
  }
  return { id: candidates[0]!.entity.id, candidates: result.data.results };
}

/** Raw date schedule payload; parsed by the mapper against recorded fixtures. */
export async function fetchSchedule(date: string): Promise<unknown> {
  return sportsGet<unknown>(`/schedule/${date}`);
}

/** Live matches across football; the recovery fallback for in-progress games. */
export async function fetchLiveMatches(): Promise<unknown> {
  return sportsGet<unknown>('/live');
}

/** Full match payload used to verify tournament membership of a live match. */
export async function fetchMatch(matchId: string): Promise<unknown> {
  return sportsGet<unknown>(`/match/${matchId}`);
}

/** Current incidents for a match; the reconciliation + confirmation source. */
export async function fetchMatchIncidents(matchId: string): Promise<unknown> {
  return sportsGet<unknown>(`/match/${matchId}/incidents`);
}
