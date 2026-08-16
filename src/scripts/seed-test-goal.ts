import { createHash } from "node:crypto";
import { loadEnv } from "../config/env.js";
import type { MatchEvent } from "../domain/match-event.js";
import { QUEUES, sendToQueue } from "../jobs/supabase-queues.js";
import { getSupabase } from "../supabase/client.js";

const TEST_PROVIDER_MATCH_ID = 999_000_002;

/**
 * Inserts a fake ManCity–Arsenal goal and enqueues content-generation so the
 * running worker can exercise commentary + image + dry-run publish without a
 * live Premier League match. Confirmation is skipped on purpose.
 */
async function main(): Promise<void> {
  loadEnv();
  const supabase = getSupabase();

  const { data: competition, error: competitionError } = await supabase
    .from("competitions")
    .select("id")
    .eq("slug", "premier-league")
    .single();
  if (competitionError || !competition) {
    throw new Error(
      "competitions.premier-league is missing — run 0001_init.sql first: " +
        (competitionError?.message ?? "no row"),
    );
  }

  const homeTeam = { id: 1, name: "ManCity", colours: ["#6C2423", "#FFFFFF"] };
  const awayTeam = { id: 2, name: "Arsenal", colours: ["#EF0107", "#FFFFFF"] };

  const { data: fixture, error: fixtureError } = await supabase
    .from("fixtures")
    .upsert(
      {
        provider: "sportsapi-pro",
        provider_match_id: TEST_PROVIDER_MATCH_ID,
        competition_id: competition.id,
        starts_at: new Date().toISOString(),
        status: "live",
        home_team: homeTeam,
        away_team: awayTeam,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider,provider_match_id" },
    )
    .select("id")
    .single();
  if (fixtureError || !fixture) {
    throw new Error(`test fixture upsert failed: ${fixtureError?.message}`);
  }

  const stamp = Date.now();
  const incidentId = `seed-goal-${stamp}`;
  const event: MatchEvent = {
    provider: "sportsapi-pro",
    matchId: String(TEST_PROVIDER_MATCH_ID),
    incidentId,
    competitionId: String(competition.id),
    type: "GOAL",
    status: "CONFIRMED",
    minute: 67,
    occurredAt: new Date().toISOString(),
    home: { id: "1", name: "ManCity", score: 2, colours: homeTeam.colours },
    away: { id: "2", name: "Arsenal", score: 1, colours: awayTeam.colours },
    player: { id: "10", name: "Foden" },
    rawPayloadHash: createHash("sha256").update(incidentId).digest("hex"),
  };
  const idempotencyKey = `sportsapi-pro:${TEST_PROVIDER_MATCH_ID}:${incidentId}:0`;

  const { data: inserted, error: eventError } = await supabase
    .from("match_events")
    .insert({
      idempotency_key: idempotencyKey,
      fixture_id: fixture.id,
      provider: event.provider,
      provider_match_id: TEST_PROVIDER_MATCH_ID,
      provider_incident_id: incidentId,
      event_type: event.type,
      state: "CONFIRMED",
      minute: event.minute,
      occurred_at: event.occurredAt,
      normalized: event,
      raw_payload: { seeded: true, incidentId },
      raw_payload_hash: event.rawPayloadHash,
      revision: 0,
    })
    .select("id")
    .single();
  if (eventError || !inserted) {
    throw new Error(`test match_event insert failed: ${eventError?.message}`);
  }

  await sendToQueue(QUEUES.contentGeneration, {
    idempotencyKey,
    matchEventId: inserted.id,
  });
  await sendToQueue(QUEUES.imageGeneration, {
    idempotencyKey,
    matchEventId: inserted.id,
  });

  console.log(`
Seeded a test GOAL (Foden, 67', ManCity 2–1 Arsenal).

  fixture_id:      ${fixture.id}
  match_event_id:  ${inserted.id}
  idempotency_key: ${idempotencyKey}
  queues:          ${QUEUES.contentGeneration}, ${QUEUES.imageGeneration}

Keep \`npm run dev\` running (DRY_RUN=true). Then check Supabase:

  1. match_events          id = ${inserted.id}
       CONFIRMED → GENERATING → VALIDATED
       (PUBLISHED only if dry-run is off)
  2. content_generations   match_event_id = ${inserted.id}
       post_text, alt_text, validation_passed
  3. media_assets          kind = generated_event for this event
  4. published_posts       should stay empty while DRY_RUN=true
  5. Worker logs           "DRY RUN — post not sent to X"

Re-run this script to seed another event; each run uses a new incident id.
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
