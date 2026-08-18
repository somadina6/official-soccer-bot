import {
  composeInfluencerPostText,
  extractHook,
  type CommentaryStyle,
  type GeneratedInfluencerContent,
  type InfluencerCandidate,
  type InfluencerPostOutput,
} from '../domain/content.js';
import { countEmojis, similarity } from './content-policy.js';
import {
  influencerOriginality,
  validateInfluencerContent,
} from './influencer-policy.js';

const TARGET_MIN = 120;
const TARGET_MAX = 260;

export type RankedInfluencerCandidate = {
  candidate: InfluencerCandidate;
  postText: string;
  score: number;
  valid: boolean;
  errors: string[];
};

export type InfluencerRankResult = {
  winner: GeneratedInfluencerContent | undefined;
  ranked: RankedInfluencerCandidate[];
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

function safetyScore(
  content: GeneratedInfluencerContent,
  postText: string,
  style: CommentaryStyle,
): number {
  if (content.risk === 'reject') return 0;
  const emoji = countEmojis(postText);
  const emojiBudget = style === 'dramatic' ? 2 : 1;
  const emojiPart = emoji > emojiBudget ? 0 : 1;
  const riskPart = content.risk === 'low' ? 1 : 0.4;
  return riskPart * 0.7 + emojiPart * 0.3;
}

export function rankInfluencerCandidates(
  output: InfluencerPostOutput,
  approvedFacts: string[],
  recentPosts: string[],
  style: CommentaryStyle,
): InfluencerRankResult {
  const ranked: RankedInfluencerCandidate[] = output.candidates.map(candidate => {
    const postText = composeInfluencerPostText(candidate);
    const content: GeneratedInfluencerContent = {
      postText,
      referencedFacts: output.referencedFacts,
      opinionClaims: output.opinionClaims,
      risk: output.risk,
    };
    const validation = validateInfluencerContent(content, approvedFacts, recentPosts, style);
    const reused = hookReused(candidate.hook, recentPosts);
    const valid = validation.valid && !reused;
    const errors = [
      ...(validation.valid ? [] : validation.errors),
      ...(reused ? ['hook reused from a recent post'] : []),
    ];
    const score = valid
      ? influencerOriginality(postText, recentPosts) * 0.4 +
        lengthScore(postText.length) * 0.25 +
        safetyScore(content, postText, style) * 0.25 +
        (reused ? 0 : 0.1)
      : 0;
    return { candidate, postText, score, valid, errors };
  });

  const winnerRow = ranked.filter(row => row.valid).sort((a, b) => b.score - a.score)[0];
  const winner: GeneratedInfluencerContent | undefined = winnerRow
    ? {
        postText: winnerRow.postText,
        referencedFacts: output.referencedFacts,
        opinionClaims: output.opinionClaims,
        risk: output.risk,
        candidates: output.candidates,
        rankDebug: ranked.map(row => ({
          hook: row.candidate.hook,
          score: row.score,
          valid: row.valid,
          errors: row.errors,
        })),
      }
    : undefined;

  return { winner, ranked };
}
