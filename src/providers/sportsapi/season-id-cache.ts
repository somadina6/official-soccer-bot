import { fetchPlayerStatisticsSeasons } from './rest-client.js';
import { resolveSeasonId } from './mapper.js';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const cache = new Map<string, { seasonId: string; expiresAt: number }>();

/**
 * Resolves the current season id for a tournament via one player's
 * `/statistics/seasons` payload, cached per tournament since a season only
 * changes a handful of times a year. Returns undefined (never throws) when
 * the lookup fails, so callers can degrade gracefully.
 */
export async function getSeasonId(
  tournamentId: string,
  playerId: string,
): Promise<string | undefined> {
  const cached = cache.get(tournamentId);
  if (cached && cached.expiresAt > Date.now()) return cached.seasonId;

  const raw = await fetchPlayerStatisticsSeasons(playerId);
  const seasonId = resolveSeasonId(raw, tournamentId);
  if (!seasonId) return undefined;

  cache.set(tournamentId, { seasonId, expiresAt: Date.now() + CACHE_TTL_MS });
  return seasonId;
}
