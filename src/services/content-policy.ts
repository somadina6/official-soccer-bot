import type {
  CommentarySituation,
  CommentaryStyle,
  GeneratedContent,
} from '../domain/content.js';
import { extractHook } from '../domain/content.js';
import type { MatchEvent } from '../domain/match-event.js';
import { classifySituation, requiresPlayerName } from './commentary-situation.js';

/**
 * Deterministic post-generation validator (section 7). Structured Outputs
 * controls shape, not truth: every named fact is compared with the MatchEvent
 * before publishing. Returns the full list of violations for audit.
 */

export const MAX_POST_LENGTH = 280;

const URL_PATTERN = /https?:\/\/|www\./i;
const HASHTAG_PATTERN = /#[A-Za-z0-9_]/;
const MENTION_PATTERN = /(^|[^A-Za-z0-9_])@[A-Za-z0-9_]+/;
const GENERIC_GOAL_HOOK = /^\s*go+a+l!*\s*$/i;
const SCORELINE_PATTERN = /\d+\s*[–—:-]\s*\d+/;

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

export function maxSimilarity(text: string, recentPosts: string[]): number {
  let best = 0;
  for (const previous of recentPosts) {
    const score = similarity(text, previous);
    if (score > best) best = score;
  }
  return best;
}

const SIMILARITY_THRESHOLD = 0.6;

export function countEmojis(text: string): number {
  return text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
}

function isAllCapsLine(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

export type ContentValidationOptions = {
  style?: CommentaryStyle;
  situation?: CommentarySituation;
  /**
   * True when the candidate is a raw one-line reaction with no factLine
   * (e.g. "CHELSEA WHY"). Skips the mandatory player-name/minute/score
   * callouts, which only make sense once a candidate chose to state facts.
   * Numbers are still checked against the event regardless.
   */
  raw?: boolean;
};

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

export function validateContent(
  content: GeneratedContent,
  event: MatchEvent,
  recentPosts: string[],
  approvedContext: string[] = [],
  options: ContentValidationOptions = {},
): ValidationResult {
  const errors: string[] = [];
  const text = content.postText;
  const lower = text.toLowerCase();
  const situation = options.situation ?? classifySituation(event, approvedContext);
  const style = options.style;

  if (content.risk === 'reject') errors.push('model self-flagged the content as reject');
  if (text.length === 0) errors.push('empty post text');
  if (text.length > MAX_POST_LENGTH) errors.push(`post text exceeds ${MAX_POST_LENGTH} characters (${text.length})`);
  if (URL_PATTERN.test(text)) errors.push('post text contains a URL, which is disabled');
  if (HASHTAG_PATTERN.test(text)) errors.push('post text contains a hashtag, which is disabled');
  if (MENTION_PATTERN.test(text)) errors.push('post text contains an @mention, which is disabled');

  const emojiCount = countEmojis(text);
  const maxEmoji = style === 'dramatic' ? 2 : 1;
  if (emojiCount > 2) errors.push(`post uses ${emojiCount} emojis; maximum is 2`);
  else if (emojiCount > maxEmoji) {
    errors.push(`post uses ${emojiCount} emojis; maximum is ${maxEmoji} unless style is dramatic`);
  }

  const capsLines = text.split('\n').filter(isAllCapsLine);
  if (capsLines.length > 1) errors.push('post has more than one capitalized hook');

  const hook = extractHook(text);
  if (GENERIC_GOAL_HOOK.test(hook)) errors.push('generic GOOOOAL hook is not allowed');

  if (situation !== 'full_time' && text.includes('?')) {
    errors.push('questions are reserved for full time');
  }

  for (const phrase of BANNED_SUPERLATIVES) {
    if (lower.includes(phrase)) errors.push(`unsupported superlative: "${phrase}"`);
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

  const scoreKnown = event.scoreKnown ?? true;

  if (!options.raw) {
    if (event.player && requiresPlayerName(situation) && !lower.includes(event.player.name.toLowerCase())) {
      errors.push(`post must name the player "${event.player.name}"`);
    }
    if (event.type !== 'FULL_TIME' && !text.includes(String(event.minute))) {
      errors.push(`post must contain the minute ${event.minute}`);
    }
    if (scoreKnown) {
      const scorePattern = new RegExp(`${event.home.score}\\s*[–—:-]\\s*${event.away.score}`);
      if (!scorePattern.test(text)) {
        errors.push(`post must contain the score ${event.home.score}-${event.away.score}`);
      }
    }
  }
  if (!scoreKnown && SCORELINE_PATTERN.test(text)) {
    errors.push('post must not state a score; the current score could not be confirmed for this event');
  }
  const digits = text.match(/\d+/g) ?? [];
  const allowedNumbers = new Set(
    [event.minute, event.stoppageMinute, ...(scoreKnown ? [event.home.score, event.away.score] : [])]
      .filter((n): n is number => n !== undefined)
      .map(String),
  );
  for (const fact of approvedContext) {
    for (const digit of fact.match(/\d+/g) ?? []) allowedNumbers.add(digit);
  }
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
