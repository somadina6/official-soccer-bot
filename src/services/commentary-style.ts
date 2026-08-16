import type {
  BanterTone,
  CommentarySituation,
  CommentaryStyle,
} from "../domain/content.js";

export type StyleWeight = { style: CommentaryStyle; weight: number };

/**
 * Commentary-style distribution by banter tone.
 *
 * Neutral:
 * - energetic and polished;
 * - no playful or timeline-style teasing.
 *
 * Playful:
 * - balanced football humour;
 * - occasional Football-Twitter energy.
 *
 * Spicy:
 * - timeline is the dominant style;
 * - punchy and playful remain available to prevent repetition.
 *
 * Question is only available at full time.
 */
export function styleWeights(
  situation: CommentarySituation,
  tone: BanterTone,
): StyleWeight[] {
  const fullTime = situation === "full_time";

  if (tone === "neutral") {
    if (fullTime) {
      return [
        { style: "punchy", weight: 60 },
        { style: "dramatic", weight: 25 },
        { style: "question", weight: 15 },
      ];
    }

    return [
      { style: "punchy", weight: 70 },
      { style: "dramatic", weight: 30 },
    ];
  }

  if (tone === "playful") {
    if (fullTime) {
      return [
        { style: "punchy", weight: 30 },
        { style: "playful", weight: 25 },
        { style: "dramatic", weight: 15 },
        { style: "timeline", weight: 20 },
        { style: "question", weight: 10 },
      ];
    }

    return [
      { style: "punchy", weight: 35 },
      { style: "playful", weight: 30 },
      { style: "dramatic", weight: 15 },
      { style: "timeline", weight: 20 },
    ];
  }

  // Spicy
  if (fullTime) {
    return [
      { style: "punchy", weight: 25 },
      { style: "playful", weight: 20 },
      { style: "dramatic", weight: 10 },
      { style: "timeline", weight: 35 },
      { style: "question", weight: 10 },
    ];
  }

  return [
    { style: "punchy", weight: 30 },
    { style: "playful", weight: 20 },
    { style: "dramatic", weight: 10 },
    { style: "timeline", weight: 40 },
  ];
}

export function sampleCommentaryStyle(
  situation: CommentarySituation,
  tone: BanterTone,
  random: () => number = Math.random,
): CommentaryStyle {
  const weights = styleWeights(situation, tone);
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);

  let cursor = random() * total;

  for (const entry of weights) {
    cursor -= entry.weight;

    if (cursor < 0) {
      return entry.style;
    }
  }

  return weights[weights.length - 1]!.style;
}

export const STYLE_GUIDANCE: Record<CommentaryStyle, string> = {
  punchy:
    "Punchy observation: one original, event-specific line. Tight rhythm, no fluff.",
  playful:
    "Playful banter about defending, finishing, tactics or the match situation. Club-neutral. Never identity, appearance, injury, tragedy or referee allegations.",
  dramatic:
    "Dramatic commentary. Bigger emotion. A second emoji is allowed only for this style. Still factual.",
  question:
    "Conversation question: one genuine discussion question after the fact line. Full time only. Not engagement bait.",
  timeline: [
    "Use energetic Football Twitter language with exaggerated confidence,",
    "rapid emotional reactions and playful agenda-driven framing.",
    "Write conversationally, as though posting immediately from the timeline.",
    "Use short declarations, occasional ALL CAPS and at most one expressive emoji.",
    "The joke should confidently overreact to the confirmed incident without",
    "inventing facts, targeting identity or becoming genuinely hostile.",
    "Make the post feel mischievous and reply-worthy, not polished or corporate.",
  ].join(" "),
};
