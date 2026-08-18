import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import {
  isXMediaExpired,
  uploadImage,
  setMediaAltText,
} from "../providers/x/media.js";
import { createPost } from "../providers/x/posts.js";
import { getSupabase } from "../supabase/client.js";
import { loadRuntimeSettings } from "./settings.js";
import type { ContentIntent } from "../domain/content.js";

/**
 * Application-level circuit breaker (section 9):
 * - max posts per 15-minute window and per day (from env),
 * - pause after three consecutive X authorization failures,
 * - global kill switch via settings/env.
 */
let consecutiveAuthFailures = 0;
let authPausedUntil = 0;

async function countPostsSince(since: Date): Promise<number> {
  const { count, error } = await getSupabase()
    .from("published_posts")
    .select("id", { count: "exact", head: true })
    .gte("published_at", since.toISOString());
  if (error) throw new Error(`post count failed: ${error.message}`);
  return count ?? 0;
}

export type PublishInput = {
  matchEventId?: number;
  contentJobId?: string;
  intent?: ContentIntent;
  idempotencyKey: string;
  postText: string;
  altText?: string;
  image?: Buffer;
  imageHash?: string;
  isCorrection?: boolean;
  inReplyToPostId?: string;
};

export type PublishResult =
  | { status: "published"; xPostId: string }
  | { status: "already_published"; xPostId: string }
  | { status: "skipped"; reason: string };

export async function publish(input: PublishInput): Promise<PublishResult> {
  const env = loadEnv();
  const supabase = getSupabase();

  // Idempotency: a retry must find an existing X post ID before posting again.
  const { data: existing } = await supabase
    .from("published_posts")
    .select("x_post_id")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing)
    return { status: "already_published", xPostId: existing.x_post_id };

  const settings = await loadRuntimeSettings();
  if (settings.dryRun) {
    logger.info(
      {
        idempotencyKey: input.idempotencyKey,
        postText: input.postText,
        altText: input.altText,
      },
      "DRY RUN — post not sent to X",
    );
    return { status: "skipped", reason: "dry_run" };
  }
  if (!settings.publishingEnabled)
    return { status: "skipped", reason: "publishing_disabled" };
  if (settings.manualApproval)
    return { status: "skipped", reason: "awaiting_manual_approval" };
  if (Date.now() < authPausedUntil)
    return { status: "skipped", reason: "auth_failure_pause" };

  const now = Date.now();
  const last15Min = await countPostsSince(new Date(now - 15 * 60_000));
  if (last15Min >= env.MAX_POSTS_PER_15_MIN) {
    return { status: "skipped", reason: "rate_limit_15min" };
  }
  const lastDay = await countPostsSince(new Date(now - 24 * 60 * 60_000));
  if (lastDay >= env.MAX_POSTS_PER_DAY) {
    return { status: "skipped", reason: "rate_limit_daily" };
  }

  const correlationId = randomUUID();
  try {
    let mediaId: string | undefined;

    if (input.image && input.matchEventId !== undefined) {
      // Reuse an unexpired X media ID after a retry: never re-upload the same
      // image and never regenerate it. An expired ID is re-uploaded from the
      // stored JPEG bytes passed in by the caller.
      const { data: knownMedia } = await supabase
        .from("media_assets")
        .select("id, kind, status, x_media_id, x_media_expires_at")
        .eq("match_event_id", input.matchEventId)
        .eq("kind", "generated_event")
        .maybeSingle();

      const reusable =
        knownMedia?.x_media_id && !isXMediaExpired(knownMedia.x_media_expires_at)
          ? knownMedia.x_media_id
          : undefined;

      mediaId = reusable;
      if (!mediaId) {
        const uploaded = await uploadImage(input.image);
        mediaId = uploaded.mediaId;
        // Alt-text failure is a hard error: do not publish inaccessible media.
        await setMediaAltText(mediaId, input.altText ?? "");
        if (knownMedia) {
          await supabase
            .from("media_assets")
            .update({
              x_media_id: mediaId,
              x_media_expires_at: uploaded.expiresAt.toISOString(),
              status:
                knownMedia.status === "fallback_used"
                  ? "fallback_used"
                  : "uploaded_to_x",
              alt_text: input.altText ?? "",
              image_hash: input.imageHash,
            })
            .eq("id", knownMedia.id);
        } else {
          await supabase.from("media_assets").insert({
            match_event_id: input.matchEventId,
            kind: "final_composite",
            status: "uploaded_to_x",
            image_hash: input.imageHash,
            x_media_id: mediaId,
            x_media_expires_at: uploaded.expiresAt.toISOString(),
            alt_text: input.altText ?? "",
          });
        }
      }
    }

    const postInput: Parameters<typeof createPost>[0] = {
      text: input.postText,
    };
    if (mediaId) postInput.mediaId = mediaId;
    if (input.inReplyToPostId)
      postInput.inReplyToPostId = input.inReplyToPostId;
    const xPostId = await createPost(postInput);
    consecutiveAuthFailures = 0;

    const { error: recordError } = await supabase
      .from("published_posts")
      .insert({
        match_event_id: input.matchEventId ?? null,
        content_job_id: input.contentJobId ?? null,
        intent: input.intent ?? (input.matchEventId ? "live_reaction" : null),
        idempotency_key: input.idempotencyKey,
        x_post_id: xPostId,
        post_text: input.postText,
        x_media_id: mediaId ?? null,
        correlation_id: correlationId,
        in_reply_to_post_id: input.inReplyToPostId ?? null,
        is_correction: input.isCorrection ?? false,
        cost_estimate_usd: 0.02,
      });
    if (recordError?.code === "23505") {
      // A concurrent retry won the race; the post exists exactly once.
      const { data: winner } = await supabase
        .from("published_posts")
        .select("x_post_id")
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      return {
        status: "already_published",
        xPostId: winner?.x_post_id ?? xPostId,
      };
    }
    if (recordError) {
      logger.error(
        {
          idempotencyKey: input.idempotencyKey,
          xPostId,
          error: recordError.message,
        },
        "CRITICAL: post published but ledger insert failed — manual audit needed",
      );
    }

    logger.info({ xPostId, correlationId }, "published to X");
    return { status: "published", xPostId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("X 401") || message.includes("X 403")) {
      consecutiveAuthFailures += 1;
      if (consecutiveAuthFailures >= 3) {
        authPausedUntil = Date.now() + 15 * 60_000;
        logger.error(
          "three consecutive X authorization failures — publishing paused 15 minutes",
        );
      }
    }
    throw error;
  }
}
