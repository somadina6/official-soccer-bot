import type { GeneratedContent } from '../domain/content.js';
import type { MatchEvent } from '../domain/match-event.js';

/**
 * Deterministic post-generation validator (section 7). Structured Outputs
 * controls shape, not truth: every named fact is compared with the MatchEvent
 * before publishing. Returns the full list of violations for audit.
 */

const MAX_LENGTH = 240;

const URL_PATTERN = /https?:\/\/|www\./i;

const BANNED_SUPERLATIVES = [
  'first ever',
  'first-ever',
  'record-breaking',
  'record breaking',
  'all-time record',
  'never before',
  'in history',
];

/** Unsafe topics that must never appear regardless of tone. */
const BANNED_PHRASES = [
  'fix', 'fixed match', 'match-fixing', 'match fixing',
  'bribe', 'bribed', 'corrupt', 'rigged', 'bent ref',
  'bet ', 'betting', 'odds', 'parlay', 'stake',
  'ugly', 'fat', 'idiot', 'stupid', 'disgrace of a human',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Jaccard similarity over word bigrams; cheap stand-in for embeddings. */
export function similarity(a: string, b: string): number {
  const bigrams = (text: string): Set<string> => {
    const words = normalize(text).split(' ');
    const grams = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) grams.add(`${words[i]} ${words[i + 1]}`);
    return grams;
  };
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared++;
  return shared / (gramsA.size + gramsB.size - shared);
}

const SIMILARITY_THRESHOLD = 0.6;

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

export function validateContent(
  content: GeneratedContent,
  event: MatchEvent,
  recentPosts: string[],
): ValidationResult {
  const errors: string[] = [];
  const text = content.postText;
  const lower = text.toLowerCase();

  if (content.risk === 'reject') errors.push('model self-flagged the content as reject');
  if (text.length === 0) errors.push('empty post text');
  if (text.length > MAX_LENGTH) errors.push(`post text exceeds ${MAX_LENGTH} characters (${text.length})`);
  if (URL_PATTERN.test(text)) errors.push('post text contains a URL, which is disabled');
  if (!content.altText.toLowerCase().includes('ai-generated')) {
    errors.push('alt text must disclose the artwork is AI-generated');
  }

  for (const phrase of BANNED_SUPERLATIVES) {
    if (lower.includes(phrase)) errors.push(`unsupported superlative: "${phrase}"`);
  }
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) errors.push(`banned phrase: "${phrase.trim()}"`);
  }

  // Factual checks: player, minute and score must exactly match the event.
  if (event.player && !lower.includes(event.player.name.toLowerCase())) {
    errors.push(`post must name the player "${event.player.name}"`);
  }
  if (event.type !== 'FULL_TIME' && !text.includes(String(event.minute))) {
    errors.push(`post must contain the minute ${event.minute}`);
  }
  const scorePattern = new RegExp(`${event.home.score}\\s*[–—:-]\\s*${event.away.score}`);
  if (!scorePattern.test(text)) {
    errors.push(`post must contain the score ${event.home.score}-${event.away.score}`);
  }
  // Guard against transposed or invented scoreline digits.
  const digits = text.match(/\d+/g) ?? [];
  const allowedNumbers = new Set(
    [event.minute, event.stoppageMinute, event.home.score, event.away.score]
      .filter((n): n is number => n !== undefined)
      .map(String),
  );
  for (const digit of digits) {
    if (!allowedNumbers.has(digit)) errors.push(`unexpected number "${digit}" not present in the event`);
  }

  for (const previous of recentPosts) {
    if (similarity(text, previous) >= SIMILARITY_THRESHOLD) {
      errors.push('post is substantially similar to a recent post');
      break;
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
