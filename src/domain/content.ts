import { z } from "zod";

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

export function composePostText(candidate: CommentaryCandidate): string {
  return `${candidate.hook}\n\n${candidate.factLine}\n\n${candidate.punchline}`;
}

export function extractHook(postText: string): string {
  const first = postText.split("\n")[0]?.trim();
  return first || postText.slice(0, 48);
}
