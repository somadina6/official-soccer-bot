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
 * Only punchy and timeline are in rotation. Spicy leans harder into
 * timeline; neutral and playful lean more toward punchy.
 */
export function styleWeights(
  _situation: CommentarySituation,
  tone: BanterTone,
): StyleWeight[] {
  if (tone === "spicy") {
    return [
      { style: "punchy", weight: 40 },
      { style: "timeline", weight: 60 },
    ];
  }

  if (tone === "playful") {
    return [
      { style: "punchy", weight: 50 },
      { style: "timeline", weight: 50 },
    ];
  }

  // Neutral
  return [
    { style: "punchy", weight: 60 },
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
