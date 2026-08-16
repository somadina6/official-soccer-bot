import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { discoverTeamId } from '../providers/sportsapi/rest-client.js';
import { getSupabase } from '../supabase/client.js';

export async function loadWatchedTeamIds(): Promise<Set<number>> {
  const { data, error } = await getSupabase()
    .from('watched_clubs')
    .select('provider_team_id')
    .not('provider_team_id', 'is', null);
  if (error) throw new Error(`watched_clubs lookup failed: ${error.message}`);
  return new Set(
    (data ?? [])
      .map(row => Number(row.provider_team_id))
      .filter(id => Number.isFinite(id)),
  );
}

/**
 * For each watched_clubs row without a provider team id, search SportsAPI
 * and persist the unique England-side (or configured country) match.
 */
export async function discoverWatchedClubs(): Promise<Set<number>> {
  const { data, error } = await getSupabase()
    .from('watched_clubs')
    .select('id, slug, expected_name, expected_country, provider_team_id');
  if (error) throw new Error(`watched_clubs query failed: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) return new Set();

  if (!loadEnv().SPORTSAPI_ENABLED) {
    const known = rows
      .map(row => Number(row.provider_team_id))
      .filter(id => Number.isFinite(id));
    if (rows.some(row => !row.provider_team_id)) {
      logger.warn('SPORTSAPI_ENABLED=false; watched clubs without a team id were not discovered');
    }
    return new Set(known);
  }

  for (const row of rows) {
    if (row.provider_team_id) continue;
    try {
      const teamId = await discoverTeamId(row.expected_name, row.expected_country);
      const { error: updateError } = await getSupabase()
        .from('watched_clubs')
        .update({ provider_team_id: teamId, verified_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updateError) throw new Error(`failed to store team id for ${row.slug}: ${updateError.message}`);
      logger.info({ slug: row.slug, teamId }, 'stored discovered watched club team ID');
    } catch (error) {
      logger.warn({ error, slug: row.slug }, 'watched club discovery failed; continuing without it');
    }
  }

  return loadWatchedTeamIds();
}
