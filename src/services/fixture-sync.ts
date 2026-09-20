import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import {
  discoverPremierLeagueId,
  fetchLiveMatches,
  fetchSchedule,
} from "../providers/sportsapi/rest-client.js";
import {
  canonicalTournamentName,
  extractLiveMatches,
  extractScheduledMatches,
  shouldWatchMatch,
} from "../providers/sportsapi/mapper.js";
import { getSupabase } from "../supabase/client.js";
import { scheduleMatchContent } from "./content-jobs.js";
import { loadWatchedTeamIds } from "./watched-clubs.js";

export type Competition = {
  id: number;
  slug: string;
  providerId: number;
};

/**
 * Loads the Premier League competition row. If no provider tournament ID has
 * been confirmed yet, runs discovery once; the result is only auto-persisted
 * because search enforced an exact unique English "Premier League" match —
 * any ambiguity throws and stops the worker for manual review (section 4).
 */
export async function loadOrDiscoverAndApproveCompetition(): Promise<Competition> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("competitions")
    .select("id, slug, provider_tournament_id")
    .eq("slug", "premier-league")
    .single();
  if (error || !data) {
    throw new Error(
      "competitions row for premier-league is missing — run migrations first: " +
        (error?.message ?? "no row"),
    );
  }

  if (data.provider_tournament_id) {
    return {
      id: data.id,
      slug: data.slug,
      providerId: Number(data.provider_tournament_id),
    };
  }

  if (!loadEnv().SPORTSAPI_ENABLED) {
    throw new Error(
      "competitions.provider_tournament_id is empty and SPORTSAPI_ENABLED=false. " +
        "Set SPORTSAPI_ENABLED=true once to discover the Premier League id, or store it manually.",
    );
  }

  logger.info("no stored tournament ID; running SportsAPI discovery");
  const discovered = await discoverPremierLeagueId();

  const { error: updateError } = await supabase
    .from("competitions")
    .update({
      provider_tournament_id: discovered.id,
      verified_at: new Date().toISOString(),
    })
    .eq("id", data.id);
  if (updateError)
    throw new Error(`failed to store tournament ID: ${updateError.message}`);

  logger.info(
    { tournamentId: discovered.id },
    "stored discovered Premier League tournament ID",
  );
  return { id: data.id, slug: data.slug, providerId: discovered.id };
}

/**
 * Fetches one date's schedule and upserts Premier League fixtures plus any
 * other match that involves a watched club.
 */
export async function syncSchedule(
  date: string,
  competition: Competition,
): Promise<number> {
  const payload = await fetchSchedule(date);
  const matches = extractScheduledMatches(payload);
  const watchedTeamIds = await loadWatchedTeamIds();
  const watched = matches.filter((m) =>
    shouldWatchMatch(m, competition.providerId, watchedTeamIds),
  );
  if (watched.length === 0) return 0;

  const { error } = await getSupabase()
    .from("fixtures")
    .upsert(
      watched.map((m) => ({
        provider: "sportsapi-pro",
        provider_match_id: m.id,
        competition_id: competition.id,
        competition_name: canonicalTournamentName(m) ?? null,
        starts_at: new Date(m.startTimestamp * 1000).toISOString(),
        home_team: m.homeTeam,
        away_team: m.awayTeam,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "provider,provider_match_id" },
    );
  if (error) throw new Error(`fixture upsert failed: ${error.message}`);

  await scheduleFixturesByProviderIds(watched.map((m) => m.id));

  logger.info(
    { date, fixtures: watched.length, watchedClubs: watchedTeamIds.size },
    "schedule synced",
  );
  return watched.length;
}

/**
 * Recovery check: upserts any live Premier League or watched-club match
 * missed because of a postponement or schedule change, and marks it live.
 */
export async function reconcileCurrentlyLive(
  competition: Competition,
): Promise<number> {
  const payload = await fetchLiveMatches();
  const watchedTeamIds = await loadWatchedTeamIds();
  const live = extractLiveMatches(payload).filter((m) =>
    shouldWatchMatch(m, competition.providerId, watchedTeamIds),
  );
  if (live.length === 0) return 0;

  const { error } = await getSupabase()
    .from("fixtures")
    .upsert(
      live.map((m) => ({
        provider: "sportsapi-pro",
        provider_match_id: m.id,
        competition_id: competition.id,
        competition_name: canonicalTournamentName(m) ?? null,
        starts_at: new Date(m.startTimestamp * 1000).toISOString(),
        status: "live",
        home_team: m.homeTeam,
        away_team: m.awayTeam,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "provider,provider_match_id" },
    );
  if (error) throw new Error(`live fixture upsert failed: ${error.message}`);

  await scheduleFixturesByProviderIds(live.map((m) => m.id));

  logger.info({ live: live.length }, "live reconciliation complete");
  return live.length;
}

async function scheduleFixturesByProviderIds(providerMatchIds: number[]): Promise<void> {
  if (providerMatchIds.length === 0) return;
  const { data, error } = await getSupabase()
    .from("fixtures")
    .select("id, starts_at, status")
    .eq("provider", "sportsapi-pro")
    .in("provider_match_id", providerMatchIds);
  if (error) throw new Error(`fixture schedule lookup failed: ${error.message}`);
  for (const fixture of data ?? []) {
    await scheduleMatchContent({
      id: fixture.id,
      starts_at: fixture.starts_at,
      status: fixture.status,
    });
  }
}

const SIX_HOURS = 6 * 60 * 60_000;
const LIVE_RECONCILE_MS = 30 * 60 * 1000;

/**
 * Periodic fixture synchronization: full date schedules every six hours and
 * shortly after midnight UTC; `/live/all` every 30 minutes so a postponed or
 * cup match is picked up without a football-wide WebSocket. `onSynced` lets
 * the feed subscribe to any newly upserted match ids (no extra REST).
 */
export function startFixtureSyncSchedule(
  competition: Competition,
  onSynced?: () => Promise<void> | void,
): () => void {
  let inFlight = false;

  const run = async (includeSchedule: boolean, label: string) => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (includeSchedule) {
        const today = new Date();
        const tomorrow = new Date(today.getTime() + 86_400_000);
        await syncSchedule(today.toISOString().slice(0, 10), competition);
        await syncSchedule(tomorrow.toISOString().slice(0, 10), competition);
      }
      await reconcileCurrentlyLive(competition);
      await onSynced?.();
    } catch (err) {
      logger.error({ err }, label);
    } finally {
      inFlight = false;
    }
  };

  const scheduleInterval = setInterval(() => {
    void run(true, "scheduled fixture sync failed");
  }, SIX_HOURS);

  const liveInterval = setInterval(() => {
    void run(false, "scheduled live reconcile failed");
  }, LIVE_RECONCILE_MS);

  // Next-day sync shortly after midnight UTC.
  const now = new Date();
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    5,
  );
  const midnightTimer = setTimeout(() => {
    void run(true, "midnight fixture sync failed");
  }, nextMidnight - now.getTime());

  return () => {
    clearInterval(scheduleInterval);
    clearInterval(liveInterval);
    clearTimeout(midnightTimer);
  };
}
