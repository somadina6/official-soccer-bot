import { logger } from '../observability/logger.js';
import { fetchTeamCrestImage } from '../providers/sportsapi/rest-client.js';
import { downloadArtwork, storeCrest } from '../supabase/storage.js';

/** Sentinel used by toTeamSide (event-reconciler.ts) when a team id can't be resolved. */
const UNKNOWN_TEAM_ID = 'unknown';

function crestObjectPath(teamId: string): string {
  return `crests/${teamId}.png`;
}

/**
 * A team's real crest PNG from SportsAPI, cached in Supabase Storage so a
 * club's crest is only ever fetched once. Returns null (never throws) when
 * the id is unresolvable or the provider call fails, so the caller can fall
 * back to the model-drawn-crest full-time layout instead of failing the
 * whole image job over a crest fetch.
 */
export async function loadTeamCrest(teamId: string): Promise<Buffer | null> {
  if (teamId === UNKNOWN_TEAM_ID) return null;
  const objectPath = crestObjectPath(teamId);

  try {
    return await downloadArtwork(objectPath);
  } catch {
    // Not cached yet — fetch it from the provider below.
  }

  try {
    const image = await fetchTeamCrestImage(teamId);
    await storeCrest({ objectPath, image });
    return image;
  } catch (error) {
    logger.warn(
      { teamId, error: error instanceof Error ? error.message : error },
      'failed to fetch team crest; falling back to a model-drawn crest',
    );
    return null;
  }
}

/** Both crests for a full-time graphic. Either may be null — see loadTeamCrest. */
export async function loadMatchCrests(
  homeTeamId: string,
  awayTeamId: string,
): Promise<{ home: Buffer | null; away: Buffer | null }> {
  const [home, away] = await Promise.all([loadTeamCrest(homeTeamId), loadTeamCrest(awayTeamId)]);
  return { home, away };
}
