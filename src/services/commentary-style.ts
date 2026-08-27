import type {
  BanterTone,
  CommentarySituation,
  CommentaryStyle,
  ContentIntent,
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
        { style: "punchy", weight: 40 },
        { style: "dramatic", weight: 15 },
        { style: "timeline", weight: 30 },
        { style: "question", weight: 15 },
      ];
    }

    return [
      { style: "punchy", weight: 45 },
      { style: "dramatic", weight: 20 },
      { style: "timeline", weight: 35 },
    ];
  }

  if (tone === "playful") {
    if (fullTime) {
      return [
        { style: "punchy", weight: 20 },
        { style: "playful", weight: 20 },
        { style: "dramatic", weight: 10 },
        { style: "timeline", weight: 40 },
        { style: "question", weight: 10 },
      ];
    }

    return [
      { style: "punchy", weight: 25 },
      { style: "playful", weight: 25 },
      { style: "dramatic", weight: 10 },
      { style: "timeline", weight: 40 },
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

/**
 * Samples a commentary style from the given situation and tone.
 *
 * @param situation - The situation of the commentary.
 * @param tone - The tone of the commentary.
 * @param random - The random number generator.
 * @returns The sampled commentary style.
 */
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

const FULL_TIME_INTENTS: Exclude<ContentIntent, "live_reaction">[] = [
  "post_match_verdict",
  "question",
];

export function sampleInfluencerStyle(
  intent: Exclude<ContentIntent, "live_reaction">,
  tone: BanterTone,
  random: () => number = Math.random,
): CommentaryStyle {
  const situation = FULL_TIME_INTENTS.includes(intent) ? "full_time" : "goal";
  return sampleCommentaryStyle(situation, tone, random);
}

export const STYLE_GUIDANCE: Record<CommentaryStyle, string> = {
  punchy:
    "Punchy observation: one original, event-specific line. Tight rhythm, no fluff. Often just the hook, nothing else — brevity beats completeness.",
  playful:
    "Playful banter about defending, finishing, tactics or the match situation. Club-neutral. Never identity, appearance, injury, tragedy or referee allegations.",
  dramatic:
    "Dramatic commentary. Bigger emotion. A second emoji is allowed only for this style. Still factual.",
  question:
    "Conversation question: one genuine discussion question after the fact line. Full time only. Not engagement bait.",
  timeline: [
    "Use energetic Football Twitter language with exaggerated confidence,",
    "rapid emotional reactions and playful agenda-driven framing.",
    "Write conversationally, as though posting immediately from the timeline —",
    "a raw, low-filter gut reaction, not a composed caption.",
    "Prefer ONE short line. Skip the factLine and punchline unless a second",
    "beat genuinely adds something; most of these posts should be a single",
    "blunt sentence or fragment.",
    "Use short declarations, occasional ALL CAPS and at most one expressive emoji.",
    "The joke should confidently overreact to the confirmed incident without",
    "inventing facts, targeting identity or becoming genuinely hostile.",
    "Make the post feel mischievous and reply-worthy, not polished or corporate.",
  ].join(" "),
};
