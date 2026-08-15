import { logger } from "../observability/logger.js";
import {
  discoverPremierLeagueId,
  fetchLiveMatches,
  fetchSchedule,
} from "../providers/sportsapi/rest-client.js";
import {
  extractLiveMatches,
  extractScheduledMatches,
} from "../providers/sportsapi/mapper.js";
import { getSupabase } from "../supabase/client.js";

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
 * Fetches one date's schedule and upserts only fixtures whose tournament ID
 * matches the stored Premier League ID.
 */
export async function syncSchedule(
  date: string,
  competition: Competition,
): Promise<number> {
  const payload = await fetchSchedule(date);
  const matches = extractScheduledMatches(payload);
  const premierLeague = matches.filter(
    (m) => m.tournament.id === competition.providerId,
  );
  if (premierLeague.length === 0) return 0;

  const { error } = await getSupabase()
    .from("fixtures")
    .upsert(
      premierLeague.map((m) => ({
        provider: "sportsapi-pro",
        provider_match_id: m.id,
        competition_id: competition.id,
        starts_at: new Date(m.startTimestamp * 1000).toISOString(),
        home_team: m.homeTeam,
        away_team: m.awayTeam,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "provider,provider_match_id" },
    );
  if (error) throw new Error(`fixture upsert failed: ${error.message}`);

  logger.info({ date, fixtures: premierLeague.length }, "schedule synced");
  return premierLeague.length;
}

/**
 * Recovery check: upserts any live Premier League match missed because of a
 * postponement or schedule change, and marks it live.
 */
export async function reconcileCurrentlyLive(
  competition: Competition,
): Promise<number> {
  const payload = await fetchLiveMatches();
  const live = extractLiveMatches(payload).filter(
    (m) => m.tournament.id === competition.providerId,
  );
  if (live.length === 0) return 0;

  const { error } = await getSupabase()
    .from("fixtures")
    .upsert(
      live.map((m) => ({
        provider: "sportsapi-pro",
        provider_match_id: m.id,
        competition_id: competition.id,
        starts_at: new Date(m.startTimestamp * 1000).toISOString(),
        status: "live",
        home_team: m.homeTeam,
        away_team: m.awayTeam,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "provider,provider_match_id" },
    );
  if (error) throw new Error(`live fixture upsert failed: ${error.message}`);

  logger.info({ live: live.length }, "live reconciliation complete");
  return live.length;
}

const SIX_HOURS = 6 * 60 * 60_000;

/**
 * Periodic fixture synchronization: at startup, every six hours, and the next
 * day shortly after midnight UTC. (The "five minutes before earliest kick-off"
 * sync is approximated by the six-hour cadence plus live reconciliation.)
 */
export function startFixtureSyncSchedule(competition: Competition): () => void {
  const run = async () => {
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    await syncSchedule(today.toISOString().slice(0, 10), competition);
    await syncSchedule(tomorrow.toISOString().slice(0, 10), competition);
    await reconcileCurrentlyLive(competition);
  };

  const interval = setInterval(() => {
    void run().catch((err) =>
      logger.error({ err }, "scheduled fixture sync failed"),
    );
  }, SIX_HOURS);

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
    void run().catch((err) =>
      logger.error({ err }, "midnight fixture sync failed"),
    );
  }, nextMidnight - now.getTime());

  return () => {
    clearInterval(interval);
    clearTimeout(midnightTimer);
  };
}
