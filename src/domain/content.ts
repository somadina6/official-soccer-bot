import { z } from "zod";
import type { MatchEvent } from "./match-event.js";
import type {
  CompletedMatch,
  MatchSummary,
  StoredPrediction,
  UpcomingFixture,
  VerifiedResult,
} from "./influencer.js";

export const COMMENTARY_STYLES = [
  "punchy",
  "playful",
  "dramatic",
  "question",
  "timeline",
] as const;
export type CommentaryStyle = (typeof COMMENTARY_STYLES)[number];

export const COMMENTARY_SITUATIONS = [
  "goal",
  "equalizer",
  "late_winner",
  "own_goal",
  "red_card",
  "penalty_saved",
  "penalty_missed",
  "var_overturn",
  "full_time",
] as const;
export type CommentarySituation = (typeof COMMENTARY_SITUATIONS)[number];

export const CommentaryCandidateSchema = z.object({
  hook: z.string(),
  factLine: z.string(),
  punchline: z.string(),
});
export type CommentaryCandidate = z.infer<typeof CommentaryCandidateSchema>;

/** Structured output from the text model: two copy candidates plus alt text. */
export const CommentaryModelOutputSchema = z.object({
  candidates: z.array(CommentaryCandidateSchema).length(2),
  altText: z.string(),
  referencedFacts: z.array(z.string()),
  risk: z.enum(["low", "review", "reject"]),
});
export type CommentaryModelOutput = z.infer<typeof CommentaryModelOutputSchema>;

export const GeneratedContentSchema = z.object({
  postText: z.string(),
  altText: z.string(),
  referencedFacts: z.array(z.string()),
  risk: z.enum(["low", "review", "reject"]),
});

export type GeneratedContent = z.infer<typeof GeneratedContentSchema> & {
  candidates?: CommentaryCandidate[];
  rankDebug?: unknown;
};

export type BanterTone = "neutral" | "playful" | "spicy";

export const CONTENT_INTENTS = [
  "live_reaction",
  "post_match_verdict",
  "hot_take",
  "prediction",
  "question",
  "receipt",
] as const;
export type ContentIntent = (typeof CONTENT_INTENTS)[number];

export const InfluencerCandidateSchema = z.object({
  hook: z.string(),
  factLine: z.string(),
  opinion: z.string(),
  punchline: z.string(),
});
export type InfluencerCandidate = z.infer<typeof InfluencerCandidateSchema>;

export const InfluencerPostOutputSchema = z.object({
  candidates: z.array(InfluencerCandidateSchema).length(2),
  referencedFacts: z.array(z.string()),
  opinionClaims: z.array(z.string()),
  risk: z.enum(["low", "review", "reject"]),
});
export type InfluencerPostOutput = z.infer<typeof InfluencerPostOutputSchema>;

export type SharedContentInput = {
  tone: BanterTone;
  style: CommentaryStyle;
  approvedFacts: string[];
  recentOpenings: string[];
};

export type ContentGenerationInput =
  | (SharedContentInput & {
      intent: "live_reaction";
      event: MatchEvent;
      situation: CommentarySituation;
    })
  | (SharedContentInput & {
      intent: "post_match_verdict";
      match: CompletedMatch;
    })
  | (SharedContentInput & {
      intent: "hot_take";
      subject: {
        player?: string;
        team?: string;
      };
    })
  | (SharedContentInput & {
      intent: "prediction";
      fixture: UpcomingFixture;
    })
  | (SharedContentInput & {
      intent: "question";
      match: MatchSummary;
    })
  | (SharedContentInput & {
      intent: "receipt";
      prediction: StoredPrediction;
      result: VerifiedResult;
    });

export type GeneratedInfluencerContent = {
  postText: string;
  referencedFacts: string[];
  opinionClaims: string[];
  risk: "low" | "review" | "reject";
  candidates?: InfluencerCandidate[];
  rankDebug?: unknown;
};

/**
 * factLine and punchline are optional: a raw one-line reaction (just the
 * hook) is a valid, often preferable, post — real fan accounts rarely pad
 * every tweet out to three lines.
 */
export function composePostText(candidate: CommentaryCandidate): string {
  return [candidate.hook, candidate.factLine, candidate.punchline]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export function composeInfluencerPostText(candidate: InfluencerCandidate): string {
  return [candidate.hook, candidate.factLine, candidate.opinion, candidate.punchline]
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

export function extractHook(postText: string): string {
  const first = postText.split("\n")[0]?.trim();
  return first || postText.slice(0, 48);
}
