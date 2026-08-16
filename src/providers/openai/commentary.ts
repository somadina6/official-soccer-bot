import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { loadEnv } from '../../config/env.js';
import {
  CommentaryModelOutputSchema,
  composePostText,
  extractHook,
  type BanterTone,
  type CommentaryCandidate,
  type CommentaryModelOutput,
  type CommentarySituation,
  type CommentaryStyle,
  type GeneratedContent,
} from '../../domain/content.js';
import type { MatchEvent } from '../../domain/match-event.js';
import { logger } from '../../observability/logger.js';
import { classifySituation, SITUATION_GUIDANCE } from '../../services/commentary-situation.js';
import { STYLE_GUIDANCE } from '../../services/commentary-style.js';

let client: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (client) return client;
  client = new OpenAI({ apiKey: loadEnv().OPENAI_API_KEY });
  return client;
}

const TONE_GUIDANCE: Record<BanterTone, string> = {
  neutral: 'Energetic commentary with almost no teasing. Sharpness ceiling: do not mock a team or player.',
  playful: 'Light rivalry jokes about defending, finishing, tactics or the match situation.',
  spicy: 'Sharper jokes, still strictly within the safety rules. Never identity, appearance, injury, tragedy or referee allegations.',
};

const BANNED_CLICHE_PROMPT = [
  '"What a moment!"',
  '"The beautiful game!"',
  '"Football, bloody hell!"',
  '"Scenes!"',
  '"The stadium erupts!"',
  '"Against all odds!"',
  '"A night to remember!"',
  '"Clinical finish!"',
  '"Game on!"',
  'footballing gods / eternal symphony / destiny-chapter metaphors',
].join(', ');

function commentaryPolicy(
  tone: BanterTone,
  style: CommentaryStyle,
  situation: CommentarySituation,
): string {
  return [
    'You write live Premier League posts for X as an informed football fan with quick wit — not a robotic scoreboard and not a rage-bait troll.',
    'The account is club-neutral. Banter targets defending, finishing, tactics or the match situation — never identity, appearance, injury, tragedy or allegations about referees.',
    '',
    'STRUCTURE: produce exactly three distinct candidates. Each candidate has three compact parts:',
    '  hook — one emotional first line. At most one capitalized hook; only this line may be ALL CAPS.',
    '  factLine — the confirmed event fact (player/team, minute, score).',
    '  punchline — one original observation. Humour must come from this incident, not a forced metaphor.',
    'The published post is those three lines separated by newlines. Target 100–220 characters total. Absolute maximum 240.',
    '',
    `Tone ceiling: ${tone}. ${TONE_GUIDANCE[tone]}`,
    `Assigned style (use this style for ALL three candidates): ${style}. ${STYLE_GUIDANCE[style]}`,
    `Situation: ${situation}. ${SITUATION_GUIDANCE[situation]}`,
    '',
    'HARD RULES:',
    '- You may ONLY use facts present in the event JSON or the provided context dictionary. Never invent facts, statistics, records or history.',
    '- Context dictionary entries that describe how the incident happened (body part, placement, position, open play vs penalty, penalty saved/missed, goalkeeper name) are verified provider facts. Use them when they fit; do not require them.',
    '- Zero or one emoji normally. Two emojis only if the assigned style is dramatic.',
    '- No URLs. No hashtags. No unsolicited @mentions. Plain team and player names only.',
    '- No questions unless the assigned style is question (full time).',
    '- Do not lead goals with GOOOOAL, GOAL!, or stretched goal spellings. Vary the hook.',
    '- Short sentences with natural rhythm. One event-specific metaphor or observation per candidate.',
    `- Never use these clichés: ${BANNED_CLICHE_PROMPT}.`,
    '- No slurs, protected-class references, abuse about appearance, mockery of injury or tragedy, sexual content, referee-corruption claims, or match-fixing allegations.',
    '- No unsupported superlatives such as "first ever" or "record-breaking".',
    '- Do not reuse any recent post openings you are shown. Each of the three candidates must have a different hook.',
    '- Candidates must differ from each other in hook and punchline — not three paraphrases of the same joke.',
    '',
    'Also produce: an image prompt for an abstract editorial illustration in the two teams\' colour palettes (no logos, league marks, sponsor marks or recognizable player likenesses), and descriptive alt text that states the artwork is AI-generated and describes the overlay facts.',
    'Set risk to "review" if anything might be borderline, "reject" if you cannot produce a safe post.',
  ].join('\n');
}

export type CommentaryInput = {
  event: MatchEvent;
  tone: BanterTone;
  style: CommentaryStyle;
  situation: CommentarySituation;
  /** Short, operator-approved rivalry/context dictionary. */
  contextDictionary: string[];
  /** Last 20 posts, to avoid repetition. */
  recentOpenings: string[];
};

/** Generates three schema-constrained copy candidates. Shape is guaranteed by
 * Structured Outputs; truth is enforced separately by the deterministic validator. */
export async function generateCommentary(input: CommentaryInput): Promise<CommentaryModelOutput> {
  const env = loadEnv();
  logger.debug({ input }, 'generating commentary');
  const completion = await getOpenAI().beta.chat.completions.parse({
    model: env.OPENAI_TEXT_MODEL,
    messages: [
      { role: 'system', content: commentaryPolicy(input.tone, input.style, input.situation) },
      {
        role: 'user',
        content: JSON.stringify({
          event: input.event,
          situation: input.situation,
          style: input.style,
          approvedContext: input.contextDictionary,
          recentOpenings: input.recentOpenings.map(extractHook),
        }),
      },
    ],
    response_format: zodResponseFormat(CommentaryModelOutputSchema, 'generated_content'),
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error('OpenAI returned no parsed structured output');
  return parsed;
}

function scoreline(event: MatchEvent): string {
  return `${event.home.name} ${event.home.score}\u2013${event.away.score} ${event.away.name}`;
}

function keeperName(approvedContext: string[]): string | undefined {
  for (const fact of approvedContext) {
    const match = fact.match(/^goalkeeper\s+(.+)$/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function minuteLabel(event: MatchEvent): string {
  if (event.stoppageMinute !== undefined && event.stoppageMinute > 0) {
    return `${event.minute}+${event.stoppageMinute}'`;
  }
  return `${event.minute}'`;
}

function fallbackCandidate(event: MatchEvent, situation: CommentarySituation, approvedContext: string[]): CommentaryCandidate {
  const score = scoreline(event);
  const player = event.player?.name;
  const minute = minuteLabel(event);

  switch (situation) {
    case 'equalizer':
      return {
        hook: 'BACK FROM THE DEAD.',
        factLine: player
          ? `${player} levels it at ${minute}. ${score}.`
          : `Level at ${minute}. ${score}.`,
        punchline: 'This match has misplaced the brakes.',
      };
    case 'late_winner':
      return {
        hook: 'DELIVERED LATE.',
        factLine: player ? `${player}, ${minute}. ${score}.` : `${minute}. ${score}.`,
        punchline: 'Three points at the last possible address.',
      };
    case 'own_goal':
      return {
        hook: 'OWN GOAL.',
        factLine: player ? `${player}, ${minute}. ${score}.` : `${minute}. ${score}.`,
        punchline: 'Football can be cruel.',
      };
    case 'red_card':
      return {
        hook: 'EARLY SHOWER.',
        factLine: `Red card at ${minute}. ${score}.`,
        punchline: 'The tactical plan has just been fed into the shredder.',
      };
    case 'penalty_saved': {
      const keeper = keeperName(approvedContext);
      return {
        hook: 'NOT TODAY.',
        factLine: keeper
          ? `${keeper} saves the ${minute} penalty. ${score}.`
          : `Penalty saved at ${minute}. ${score}.`,
        punchline: 'Read it like tomorrow\'s newspaper.',
      };
    }
    case 'penalty_missed':
      return {
        hook: 'PENALTY MISSED.',
        factLine: player ? `${player}, ${minute}. ${score}.` : `Penalty missed at ${minute}. ${score}.`,
        punchline: 'Chance gone.',
      };
    case 'var_overturn':
      return {
        hook: 'NO GOAL. VAR HAS SPOKEN.',
        factLine: `The ${minute} goal is overturned. It stays ${event.home.score}\u2013${event.away.score}.`,
        punchline: 'Celebrations returned with the receipt.',
      };
    case 'full_time':
      return {
        hook: 'FULL TIME.',
        factLine: score,
        punchline: 'The whistle has the final word.',
      };
    case 'goal':
    default:
      return {
        hook: 'THAT CHANGES THINGS.',
        factLine: player ? `${player}, ${minute}. ${score}.` : `${minute}. ${score}.`,
        punchline: 'The temperature just moved.',
      };
  }
}

/**
 * Deterministic safe template used when generation or validation fails twice.
 * The event is never missed because of an AI failure.
 */
export function fallbackTemplate(event: MatchEvent, approvedContext: string[] = []): GeneratedContent {
  const situation = classifySituation(event, approvedContext);
  const candidate = fallbackCandidate(event, situation, approvedContext);
  const postText = composePostText(candidate);
  const score = scoreline(event);
  const facts = [minuteLabel(event), score];
  if (event.player?.name) facts.unshift(event.player.name);
  return {
    postText,
    imagePrompt:
      `Abstract editorial football illustration, stadium lighting, dramatic mood, ` +
      `colour palette inspired by ${event.home.colours.join('/') || event.home.name} and ` +
      `${event.away.colours.join('/') || event.away.name}. No logos, no text, no real faces.`,
    altText:
      `AI-generated editorial football illustration in ${event.home.name} and ${event.away.name} colours. ` +
      `Overlay: ${candidate.factLine}`,
    referencedFacts: facts,
    risk: 'low',
  };
}
