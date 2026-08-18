import type { CommentaryStyle, GeneratedInfluencerContent } from '../domain/content.js';
import { extractHook } from '../domain/content.js';
import { countEmojis, maxSimilarity, similarity } from './content-policy.js';

export const MAX_INFLUENCER_POST_LENGTH = 280;

const URL_PATTERN = /https?:\/\/|www\./i;
const HASHTAG_PATTERN = /#[A-Za-z0-9_]/;
const MENTION_PATTERN = /(^|[^A-Za-z0-9_])@[A-Za-z0-9_]+/;

const BANNED_PHRASES = [
  'fix', 'fixed match', 'match-fixing', 'match fixing',
  'bribe', 'bribed', 'corrupt', 'rigged', 'bent ref',
  'bet ', 'betting', 'odds', 'parlay', 'stake',
  'ugly', 'fat', 'idiot', 'stupid', 'disgrace of a human',
];

const BANNED_CLICHES = [
  'what a moment',
  'the beautiful game',
  'football, bloody hell',
  'football bloody hell',
  'the stadium erupts',
  'against all odds',
  'a night to remember',
  'clinical finish',
  'game on',
  'footballing gods',
  'eternal symphony',
  'symphony of destiny',
];

const BANNED_CLICHE_WORDS = ['scenes'];

const SIMILARITY_THRESHOLD = 0.6;

export type InfluencerValidationResult = { valid: true } | { valid: false; errors: string[] };

function factSupported(fact: string, approvedFacts: string[]): boolean {
  const needle = fact.toLowerCase().trim();
  if (!needle) return true;
  return approvedFacts.some(approved => {
    const hay = approved.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
}

/**
 * Deterministic influencer validator. Career-wide conclusions are allowed as
 * opinions; invented statistics and safety violations are not.
 */
export function validateInfluencerContent(
  content: GeneratedInfluencerContent,
  approvedFacts: string[],
  recentPosts: string[],
  style?: CommentaryStyle,
): InfluencerValidationResult {
  const errors: string[] = [];
  const text = content.postText;
  const lower = text.toLowerCase();

  if (content.risk === 'reject') errors.push('model self-flagged the content as reject');
  if (text.length === 0) errors.push('empty post text');
  if (text.length > MAX_INFLUENCER_POST_LENGTH) {
    errors.push(`post text exceeds ${MAX_INFLUENCER_POST_LENGTH} characters (${text.length})`);
  }
  if (URL_PATTERN.test(text)) errors.push('post text contains a URL, which is disabled');
  if (HASHTAG_PATTERN.test(text)) errors.push('post text contains a hashtag, which is disabled');
  if (MENTION_PATTERN.test(text)) errors.push('post text contains an @mention, which is disabled');

  const emojiCount = countEmojis(text);
  const maxEmoji = style === 'dramatic' ? 2 : 1;
  if (emojiCount > 2) errors.push(`post uses ${emojiCount} emojis; maximum is 2`);
  else if (emojiCount > maxEmoji) {
    errors.push(`post uses ${emojiCount} emojis; maximum is ${maxEmoji} unless style is dramatic`);
  }

  if (content.opinionClaims.length === 0) {
    errors.push('influencer posts must list at least one opinion claim');
  }

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) errors.push(`banned phrase: "${phrase.trim()}"`);
  }
  for (const phrase of BANNED_CLICHES) {
    if (lower.includes(phrase)) errors.push(`banned cliché: "${phrase}"`);
  }
  for (const word of BANNED_CLICHE_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) errors.push(`banned cliché: "${word}"`);
  }

  for (const fact of content.referencedFacts) {
    if (!factSupported(fact, approvedFacts)) {
      errors.push(`unapproved fact: "${fact}"`);
    }
  }

  const hook = extractHook(text);
  if (!hook) errors.push('missing hook');

  for (const previous of recentPosts) {
    if (similarity(text, previous) >= SIMILARITY_THRESHOLD) {
      errors.push('post is substantially similar to a recent post');
      break;
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function influencerOriginality(postText: string, recentPosts: string[]): number {
  return 1 - maxSimilarity(postText, recentPosts);
}
