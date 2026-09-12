import { loadEnv } from "../../config/env.js";
import type {
  CommentaryStyle,
  ContentIntent,
  GeneratedContent,
} from "../../domain/content.js";
import { logger } from "../../observability/logger.js";
import {
  fallbackTemplate,
  generateCommentary,
} from "../../providers/openai/commentary.js";
import {
  extractApprovedIncidentFacts,
  extractApprovedSeasonFacts,
} from "../../providers/sportsapi/mapper.js";
import { fetchPlayerSeasonStatistics } from "../../providers/sportsapi/rest-client.js";
import { getSeasonId } from "../../providers/sportsapi/season-id-cache.js";
import { rankCandidates } from "../../services/commentary-ranker.js";
import { classifySituation } from "../../services/commentary-situation.js";
import { sampleCommentaryStyle } from "../../services/commentary-style.js";
import { validateContent } from "../../services/content-policy.js";
import { loadRuntimeSettings } from "../../services/settings.js";
import { getSupabase } from "../../supabase/client.js";
import { QUEUES } from "../supabase-queues.js";
import { maybeEnqueueXPublishing } from "./publish-join.js";
import { startConsumer } from "./runner.js";
import { loadEvent, requireMatchEventId, setEventState } from "./shared.js";

/**
 * Operator-approved rivalry/context lines. Kept deliberately small; the model
 * may not use any fact outside the event payload, these lines, and the
 * whitelisted incident facts extracted from the raw provider payload.
 */
const APPROVED_CONTEXT: string[] = [
  "North London is Arsenal and Tottenham territory.",
  "Manchester derbies split the city red and blue.",
  "Merseyside derbies are Liverpool against Everton.",
];

async function recentPostTexts(limit = 20): Promise<string[]> {
  const { data } = await getSupabase()
    .from("published_posts")
    .select("post_text")
    .order("published_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => row.post_text as string);
}

async function loadPersistedStyle(
  matchEventId: number,
): Promise<CommentaryStyle | undefined> {
  const { data } = await getSupabase()
    .from("content_generations")
    .select("style")
    .eq("match_event_id", matchEventId)
    .not("style", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.style as CommentaryStyle | undefined) ?? undefined;
}

async function recordAttempt(
  matchEventId: number,
  attempt: number,
  content: GeneratedContent,
  validationErrors: string[],
  usedFallback: boolean,
  style: CommentaryStyle,
): Promise<number> {
  const intent: ContentIntent = "live_reaction";
  const { data, error } = await getSupabase()
    .from("content_generations")
    .insert({
      match_event_id: matchEventId,
      attempt,
      model: usedFallback ? "fallback-template" : loadEnv().OPENAI_TEXT_MODEL,
      post_text: content.postText,
      alt_text: content.altText,
      referenced_facts: content.referencedFacts,
      risk: content.risk,
      validation_passed: validationErrors.length === 0,
      validation_errors: validationErrors,
      used_fallback_template: usedFallback,
      candidates: content.candidates ?? null,
      rank_debug: content.rankDebug ?? null,
      intent,
      style,
    })
    .select("id")
    .single();
  if (error)
    throw new Error(`content_generations insert failed: ${error.message}`);
  return data.id;
}

/**
 * Consumes `content-generation`: classifies the situation, samples a style,
 * generates two candidates, ranks them, and falls back to the safe template
 * after two failed attempts so the event is never missed.
 */
export function startContentGenerationConsumer(): () => void {
  return startConsumer(
    QUEUES.contentGeneration,
    async (msg) => {
      const matchEventId = requireMatchEventId(msg.message.matchEventId);
      const { idempotencyKey } = msg.message;
      const row = await loadEvent(matchEventId);
      if (!["CONFIRMED", "GENERATING"].includes(row.state)) {
        logger.debug(
          { matchEventId, state: row.state },
          "event not awaiting generation; skipping",
        );
        return;
      }
      await setEventState(matchEventId, "GENERATING");

      const settings = await loadRuntimeSettings();
      const recent = await recentPostTexts(20);
      const contextDictionary = [
        ...APPROVED_CONTEXT,
        ...extractApprovedIncidentFacts(row.rawPayload),
      ];

      if (row.event.type === "GOAL" && row.event.player?.id) {
        try {
          const seasonId = await getSeasonId(
            row.event.competitionId,
            row.event.player.id,
          );
          if (seasonId) {
            const stats = await fetchPlayerSeasonStatistics(
              row.event.player.id,
              row.event.competitionId,
              seasonId,
            );
            const seasonFacts = extractApprovedSeasonFacts(stats);
            logger.debug(
              { matchEventId, seasonId, stats, seasonFacts },
              "season stats fetched",
            );
            contextDictionary.push(...seasonFacts);
          } else {
            logger.debug(
              { matchEventId, competitionId: row.event.competitionId },
              "season id could not be resolved; skipping season stats",
            );
          }
        } catch (error) {
          logger.warn(
            { matchEventId, error },
            "season stats fetch failed; continuing without it",
          );
        }
      }

      const intent: ContentIntent = "live_reaction";
      const situation = classifySituation(row.event, contextDictionary);
      const style = sampleCommentaryStyle(situation, settings.banterTone);
      logger.debug(
        { matchEventId, intent, situation, style },
        "live reaction generation",
      );

      let approved:
        | { content: GeneratedContent; generationId: number }
        | undefined;

      for (let attempt = 1; attempt <= 2 && !approved; attempt++) {
        try {
          const output = await generateCommentary({
            event: row.event,
            tone: settings.banterTone,
            style,
            situation,
            contextDictionary,
            recentOpenings: recent,
          });
          const { winner, ranked } = rankCandidates(
            output,
            row.event,
            recent,
            contextDictionary,
            style,
            situation,
          );
          if (winner) {
            const generationId = await recordAttempt(
              matchEventId,
              attempt,
              winner,
              [],
              false,
              style,
            );
            approved = { content: winner, generationId };
          } else {
            const failed: GeneratedContent = {
              postText: ranked[0]?.postText ?? "",
              altText: output.altText,
              referencedFacts: output.referencedFacts,
              risk: output.risk,
              candidates: output.candidates,
              rankDebug: ranked.map((candidate) => ({
                hook: candidate.candidate.hook,
                score: candidate.score,
                valid: candidate.valid,
                errors: candidate.errors,
              })),
            };
            const errors = ranked.flatMap((entry) => entry.errors);
            await recordAttempt(
              matchEventId,
              attempt,
              failed,
              errors,
              false,
              style,
            );
            logger.warn(
              { matchEventId, attempt, errors },
              "generated content rejected",
            );
          }
        } catch (error) {
          console.error(error);
          logger.warn(
            { matchEventId, attempt, error },
            "commentary generation call failed",
          );
        }
      }

      if (!approved) {
        logger.warn({ matchEventId, attempt: 3 }, "fallback template used");
        const fallback = fallbackTemplate(row.event, contextDictionary);
        const result = validateContent(
          fallback,
          row.event,
          recent,
          contextDictionary,
          {
            situation,
            style: "punchy",
          },
        );
        const generationId = await recordAttempt(
          matchEventId,
          3,
          fallback,
          result.valid ? [] : result.errors,
          true,
          style,
        );
        if (!result.valid) {
          await setEventState(matchEventId, "MANUAL_REVIEW");
          logger.error(
            { matchEventId, errors: result.errors },
            "fallback template rejected",
          );
          return;
        }
        approved = { content: fallback, generationId };
      }

      await setEventState(matchEventId, "VALIDATED");
      await maybeEnqueueXPublishing(matchEventId, idempotencyKey);
    },
    { visibilityTimeout: 120 },
  );
}
