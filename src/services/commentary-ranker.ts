import {
  composePostText,
  extractHook,
  type CommentaryCandidate,
  type CommentaryModelOutput,
  type CommentarySituation,
  type CommentaryStyle,
  type GeneratedContent,
} from '../domain/content.js';
import type { MatchEvent } from '../domain/match-event.js';
import { countEmojis, maxSimilarity, similarity, validateContent } from './content-policy.js';

const TARGET_MIN = 100;
const TARGET_MAX = 220;
const GENERIC_GOAL_HOOK = /^\s*go+a+l!*\s*$/i;

export type RankedCandidate = {
  candidate: CommentaryCandidate;
  postText: string;
  score: number;
  valid: boolean;
  errors: string[];
  breakdown: {
    originality: number;
    specificity: number;
    length: number;
    safety: number;
    freshness: number;
  };
};

export type RankResult = {
  winner: GeneratedContent | undefined;
  ranked: RankedCandidate[];
};

function lengthScore(chars: number): number {
  if (chars >= TARGET_MIN && chars <= TARGET_MAX) return 1;
  if (chars < TARGET_MIN) return Math.max(0, chars / TARGET_MIN);
  if (chars <= 280) return Math.max(0, 1 - (chars - TARGET_MAX) / (280 - TARGET_MAX));
  return 0;
}

function hookReused(hook: string, recentPosts: string[]): boolean {
  const normalized = hook.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalized) return false;
  return recentPosts.some(post => {
    const previous = extractHook(post).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return previous === normalized || similarity(hook, extractHook(post)) >= 0.8;
  });
}

function specificityScore(postText: string, approvedContext: string[]): number {
  const hook = extractHook(postText);
  if (GENERIC_GOAL_HOOK.test(hook)) return 0;

  const lower = postText.toLowerCase();
  const incidentFacts = approvedContext.filter(fact => fact.length > 0 && fact.length <= 48);
  const used = incidentFacts.filter(fact => lower.includes(fact.toLowerCase())).length;
  if (incidentFacts.length === 0) return 0.6;
  return Math.min(1, 0.35 + used / Math.min(incidentFacts.length, 3) * 0.65);
}

function safetyScore(
  content: GeneratedContent,
  postText: string,
  style: CommentaryStyle,
): number {
  if (content.risk === 'reject') return 0;
  const emoji = countEmojis(postText);
  const emojiBudget = style === 'dramatic' ? 2 : 1;
  let emojiPart = 1;
  if (emoji > emojiBudget) emojiPart = 0;
  else if (emoji === 0 || emoji === 1) emojiPart = 1;
  else emojiPart = 0.85;

  const riskPart = content.risk === 'low' ? 1 : 0.4;
  return riskPart * 0.7 + emojiPart * 0.3;
}

/**
 * Ranks two copy candidates. Invalid candidates score 0. The winner is the
 * highest-scoring valid candidate, or undefined if none survive validation.
 */
export function rankCandidates(
  output: CommentaryModelOutput,
  event: MatchEvent,
  recentPosts: string[],
  approvedContext: string[],
  style: CommentaryStyle,
  situation: CommentarySituation,
): RankResult {
  const ranked: RankedCandidate[] = output.candidates.map(candidate => {
    const postText = composePostText(candidate);
    const content: GeneratedContent = {
      postText,
      altText: output.altText,
      referencedFacts: output.referencedFacts,
      risk: output.risk,
    };
    const validation = validateContent(content, event, recentPosts, approvedContext, {
      style,
      situation,
    });
    const reused = hookReused(candidate.hook, recentPosts);
    const valid = validation.valid && !reused;
    const errors = [
      ...(validation.valid ? [] : validation.errors),
      ...(reused ? ['hook reused from a recent post'] : []),
    ];

    const breakdown = {
      originality: 1 - maxSimilarity(postText, recentPosts),
      specificity: specificityScore(postText, approvedContext),
      length: lengthScore(postText.length),
      safety: safetyScore(content, postText, style),
      freshness: reused || GENERIC_GOAL_HOOK.test(candidate.hook) ? 0 : 1,
    };
    const score = valid
      ? breakdown.originality * 0.3 +
        breakdown.specificity * 0.25 +
        breakdown.length * 0.2 +
        breakdown.safety * 0.15 +
        breakdown.freshness * 0.1
      : 0;

    return { candidate, postText, score, valid, errors, breakdown };
  });

  const winnerRow = ranked
    .filter(row => row.valid)
    .sort((a, b) => b.score - a.score)[0];

  const winner: GeneratedContent | undefined = winnerRow
    ? {
        postText: winnerRow.postText,
        altText: output.altText,
        referencedFacts: output.referencedFacts,
        risk: output.risk,
        candidates: output.candidates,
        rankDebug: ranked.map(row => ({
          hook: row.candidate.hook,
          score: row.score,
          valid: row.valid,
          errors: row.errors,
          breakdown: row.breakdown,
        })),
      }
    : undefined;

  return { winner, ranked };
}
