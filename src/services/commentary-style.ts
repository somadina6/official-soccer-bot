import type { BanterTone, CommentarySituation, CommentaryStyle } from '../domain/content.js';

export type StyleWeight = { style: CommentaryStyle; weight: number };

/**
 * Launch mix: punchy 40 / playful 30 / dramatic 20 / question 10.
 * Question is only legal at full time. Neutral tone drops playful banter and
 * redistributes that share to punchy and dramatic (2:1).
 */
export function styleWeights(situation: CommentarySituation, tone: BanterTone): StyleWeight[] {
  const questionAllowed = situation === 'full_time';
  const playfulAllowed = tone !== 'neutral';

  let punchy = 40;
  let playful = 30;
  let dramatic = 20;
  let question = 10;

  if (!playfulAllowed) {
    punchy += 20;
    dramatic += 10;
    playful = 0;
  }
  if (!questionAllowed) question = 0;

  return [
    { style: 'punchy' as const, weight: punchy },
    { style: 'playful' as const, weight: playful },
    { style: 'dramatic' as const, weight: dramatic },
    { style: 'question' as const, weight: question },
  ].filter(entry => entry.weight > 0);
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
    if (cursor < 0) return entry.style;
  }
  return weights[weights.length - 1]!.style;
}

export const STYLE_GUIDANCE: Record<CommentaryStyle, string> = {
  punchy: 'Punchy observation: one original, event-specific line. Tight rhythm, no fluff.',
  playful: 'Playful banter about defending, finishing, tactics or the match situation. Club-neutral. Never identity, appearance, injury, tragedy or referee allegations.',
  dramatic: 'Dramatic commentary. Bigger emotion. A second emoji is allowed only for this style. Still factual.',
  question: 'Conversation question: one genuine discussion question after the fact line. Full time only. Not engagement bait.',
};
