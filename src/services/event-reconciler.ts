import { z } from "zod";
import type { MatchEvent } from "../domain/match-event.js";
import { logger } from "../observability/logger.js";
import {
  extractIncidents,
  normalizeIncident,
  type MatchContext,
} from "../providers/sportsapi/mapper.js";
import { fetchMatchIncidents } from "../providers/sportsapi/rest-client.js";
import { getSupabase } from "../supabase/client.js";
import { QUEUES, sendToQueue } from "../jobs/supabase-queues.js";
import { evaluateEligibility } from "./eligibility.js";
import { loadRuntimeSettings } from "./settings.js";

/** Tolerant reader for the team JSON stored on fixtures. */
const TeamJsonSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    score: z.number().int().optional(),
    colours: z.array(z.string()).optional(),
    colors: z
      .object({
        primary: z.string().optional(),
        secondary: z.string().optional(),
      })
      .optional(),
    teamColors: z
      .object({
        primary: z.string().optional(),
        secondary: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

function toTeamSide(raw: unknown, fallbackName: string) {
  const parsed = TeamJsonSchema.safeParse(raw);
  const team = parsed.success ? parsed.data : {};
  const colours =
    team.colours ??
    [
      team.teamColors?.primary,
      team.teamColors?.secondary,
      team.colors?.primary,
      team.colors?.secondary,
    ].filter((c): c is string => Boolean(c));
  return {
    id: team.id !== undefined ? String(team.id) : "unknown",
    name: team.name ?? fallbackName,
    score: team.score ?? 0,
    colours,
  };
}

type FixtureRow = {
  id: number;
  competition_id: number;
  provider_match_id: number;
  home_team: unknown;
  away_team: unknown;
  status: string;
};

async function loadFixture(matchId: string): Promise<FixtureRow | null> {
  const { data, error } = await getSupabase()
    .from("fixtures")
    .select(
      "id, competition_id, provider_match_id, home_team, away_team, status",
    )
    .eq("provider", "sportsapi-pro")
    .eq("provider_match_id", Number(matchId))
    .maybeSingle();
  if (error) throw new Error(`fixture lookup failed: ${error.message}`);
  return data as FixtureRow | null;
}

function buildContext(matchId: string, fixture: FixtureRow): MatchContext {
  return {
    matchId,
    competitionId: String(fixture.competition_id),
    home: toTeamSide(fixture.home_team, "Home"),
    away: toTeamSide(fixture.away_team, "Away"),
  };
}

/** Natural key for an incident, before the revision suffix. */
function naturalKey(event: MatchEvent): string {
  return [
    event.provider,
    event.matchId,
    event.incidentId ??
      `${event.minute}:${event.type}:${event.player?.id ?? "unknown"}`,
  ].join(":");
}

const IN_FLIGHT_STATES = new Set([
  "RECEIVED",
  "PENDING_CONFIRMATION",
  "CONFIRMED",
  "GENERATING",
  "VALIDATED",
  "PUBLISHING",
  "PUBLISHED",
]);

export type ExistingIngestRow = {
  revision: number;
  raw_payload_hash: string;
  state: string;
};

/**
 * Skip a new revision when this incident was already seen, or is already
 * progressing toward a post. Overturns always create a revision so corrections
 * can run.
 */
export function shouldSkipDuplicateIngest(
  existing: ExistingIngestRow[],
  incomingHash: string,
  incomingStatus: MatchEvent["status"],
): boolean {
  if (existing.some((row) => row.raw_payload_hash === incomingHash))
    return true;
  const latest = existing[0];
  if (!latest) return false;
  if (incomingStatus === "OVERTURNED") return false;
  return IN_FLIGHT_STATES.has(latest.state);
}

/**
 * Ingests one normalized event idempotently.
 *
 * - Same natural key + same canonical hash → duplicate, ignored (including
 *   an earlier revision whose hash later reappears).
 * - Same incident already in flight / published → ignored unless overturned.
 * - Overturned status → new revision routed to corrections.
 */
async function ingestEvent(
  event: MatchEvent,
  fixture: FixtureRow,
  rawPayload: unknown,
): Promise<void> {
  const supabase = getSupabase();
  const key = naturalKey(event);

  const { data: existing, error: lookupError } = await supabase
    .from("match_events")
    .select("id, revision, raw_payload_hash, state")
    .like("idempotency_key", `${key}:%`)
    .order("revision", { ascending: false });
  if (lookupError)
    throw new Error(`event lookup failed: ${lookupError.message}`);

  const rows = (existing ?? []) as ExistingIngestRow[];
  if (shouldSkipDuplicateIngest(rows, event.rawPayloadHash, event.status)) {
    logger.debug({ key, status: event.status }, "duplicate incident ignored");
    return;
  }

  const latest = rows[0];
  const revision = latest ? latest.revision + 1 : 0;
  const idempotencyKey = `${key}:${revision}`;

  const { data: inserted, error: insertError } = await supabase
    .from("match_events")
    .insert({
      idempotency_key: idempotencyKey,
      fixture_id: fixture.id,
      provider: event.provider,
      provider_match_id: fixture.provider_match_id,
      provider_incident_id: event.incidentId ?? null,
      event_type: event.type,
      state: "RECEIVED",
      minute: event.minute,
      stoppage_minute: event.stoppageMinute ?? null,
      occurred_at: event.occurredAt,
      normalized: event,
      raw_payload: rawPayload as never,
      raw_payload_hash: event.rawPayloadHash,
      revision,
    })
    .select("id")
    .single();

  if (insertError) {
    // Unique violation on idempotency_key = concurrent duplicate; safe to skip.
    if (insertError.code === "23505") return;
    throw new Error(`event insert failed: ${insertError.message}`);
  }

  await supabase.from("event_revisions").insert({
    match_event_id: inserted.id,
    revision,
    raw_payload: rawPayload as never,
    raw_payload_hash: event.rawPayloadHash,
  });

  // An overturn of a previously published goal goes to the corrections queue.
  if (event.status === "OVERTURNED" && latest) {
    await supabase
      .from("match_events")
      .update({ state: "OVERTURNED", updated_at: new Date().toISOString() })
      .eq("id", inserted.id);
    await sendToQueue(QUEUES.postCorrections, {
      idempotencyKey,
      matchEventId: inserted.id,
      overturnedNaturalKey: key,
    });
    logger.warn({ idempotencyKey }, "overturned event routed to corrections");
    return;
  }

  const settings = await loadRuntimeSettings();
  const decision = evaluateEligibility(event, settings);
  if (!decision.eligible) {
    await supabase
      .from("match_events")
      .update({ state: "IGNORED", updated_at: new Date().toISOString() })
      .eq("id", inserted.id);
    logger.debug({ idempotencyKey, reason: decision.reason }, "event ignored");
    return;
  }

  await supabase
    .from("match_events")
    .update({
      state: "PENDING_CONFIRMATION",
      updated_at: new Date().toISOString(),
    })
    .eq("id", inserted.id);
  await sendToQueue(
    QUEUES.eventConfirmation,
    { idempotencyKey, matchEventId: inserted.id },
    decision.confirmationDelaySeconds,
  );
  logger.info(
    {
      idempotencyKey,
      type: event.type,
      delay: decision.confirmationDelaySeconds,
    },
    "event queued for confirmation",
  );
}

export type IngestInput = {
  matchId: string;
  kind: "snapshot" | "update";
  payload: unknown;
  receivedAt: string;
};

export type IngestResult = {
  /** True when this payload included full-time, or the fixture is already finished. */
  fullTime: boolean;
};

/**
 * Entry point for both WebSocket messages and REST reconciliation payloads.
 * Snapshots pass through the same idempotent diff, so a resent snapshot never
 * creates a duplicate job.
 */
export async function ingestAndDiff(input: IngestInput): Promise<IngestResult> {
  logger.info({ matchId: input.matchId }, "ingestAndDiff started");

  const fixture = await loadFixture(input.matchId);
  if (!fixture) {
    logger.warn(
      { matchId: input.matchId },
      "message for unknown fixture ignored",
    );
    return { fullTime: false };
  }
  const context = buildContext(input.matchId, fixture);
  let fullTime = fixture.status === "finished";

  logger.info({ payload: input.payload }, "payload");
  const rawIncidents = extractIncidents(input.payload);
  // Some channels send a single incident object rather than a list.
  const candidates = rawIncidents.length > 0 ? rawIncidents : [input.payload];

  for (const raw of candidates) {
    logger.info({ raw }, "raw incident");
    const event = normalizeIncident(raw, context);
    if (!event) {
      logger.warn({ raw }, "normalized event failed");
      continue;
    }

    logger.info({ event }, "normalized event");
    await ingestEvent(event, fixture, raw);

    if (event.type === "FULL_TIME") {
      fullTime = true;
      await getSupabase()
        .from("fixtures")
        .update({ status: "finished", updated_at: new Date().toISOString() })
        .eq("id", fixture.id);
    }
  }
  return { fullTime };
}

/** REST reconciliation for one match: used after reconnects, suspicious score
 * changes and the final whistle so no event is missed. */
export async function reconcileMatchFromRest(
  matchId: string,
): Promise<IngestResult> {
  const payload = await fetchMatchIncidents(matchId);
  return ingestAndDiff({
    matchId,
    kind: "snapshot",
    payload,
    receivedAt: new Date().toISOString(),
  });
}

/** Reconciles every fixture currently marked live. Returns match IDs that are now full-time. */
export async function reconcileAllLiveMatches(): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from("fixtures")
    .select("provider_match_id")
    .eq("status", "live");
  if (error) throw new Error(`live fixture query failed: ${error.message}`);
  const finished: string[] = [];
  for (const row of data ?? []) {
    const matchId = String(row.provider_match_id);
    try {
      const result = await reconcileMatchFromRest(matchId);
      if (result.fullTime) finished.push(matchId);
    } catch (err) {
      logger.error({ err, matchId }, "match reconciliation failed");
    }
  }
  return finished;
}
