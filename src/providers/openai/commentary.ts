import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { loadEnv } from '../../config/env.js';
import { GeneratedContentSchema, type BanterTone, type GeneratedContent } from '../../domain/content.js';
import type { MatchEvent } from '../../domain/match-event.js';
import { logger } from '../../observability/logger.js';

let client: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (client) return client;
  client = new OpenAI({ apiKey: loadEnv().OPENAI_API_KEY });
  return client;
}

const TONE_GUIDANCE: Record<BanterTone, string> = {
  neutral: 'Energetic commentary with almost no teasing.',
  playful: 'Light rivalry jokes and football idioms.',
  spicy: 'Sharper jokes, still strictly within the safety rules.',
};

function commentaryPolicy(tone: BanterTone): string {
  return [
    'You write short, punchy live-football posts for X about Premier League events.',
    'Structure: one factual event line (player, minute, score, event type), then one short commentary/banter line.',
    `Tone: ${tone}. ${TONE_GUIDANCE[tone]}`,
    'HARD RULES:',
    '- You may ONLY use facts present in the event JSON or the provided context dictionary. Never invent facts, statistics, records or history.',
    '- Context dictionary entries that describe how the incident happened (body part, placement, position, open play vs penalty) are verified provider facts. Use them when they fit; do not require them.',
    '- Maximum 240 characters of post text.',
    '- No URLs, hashtags spam, or betting advice.',
    '- No slurs, protected-class references, abuse about appearance, mockery of injury or tragedy, sexual content, referee-corruption claims, or match-fixing allegations.',
    '- Banter targets the football moment or team performance, never a person\'s identity.',
    '- No unsupported superlatives such as "first ever" or "record-breaking".',
    '- Avoid repeating any of the recent post openings you are shown.',
    'Also produce: an image prompt for an abstract editorial illustration in the two teams\' colour palettes (no logos, league marks, sponsor marks or recognizable player likenesses), and descriptive alt text that states the artwork is AI-generated and describes the overlay facts.',
    'Set risk to "review" if anything might be borderline, "reject" if you cannot produce a safe post.',
  ].join('\n');
}

export type CommentaryInput = {
  event: MatchEvent;
  tone: BanterTone;
  /** Short, operator-approved rivalry/context dictionary. */
  contextDictionary: string[];
  /** Last 10 post openings, to avoid repetition. */
  recentOpenings: string[];
};

/** Generates schema-constrained commentary. Shape is guaranteed by Structured
 * Outputs; truth is enforced separately by the deterministic validator. */
export async function generateCommentary(input: CommentaryInput): Promise<GeneratedContent> {
  const env = loadEnv();
  logger.debug({ input }, 'generating commentary');
  const completion = await getOpenAI().beta.chat.completions.parse({
    model: env.OPENAI_TEXT_MODEL,
    messages: [
      { role: 'system', content: commentaryPolicy(input.tone) },
      {
        role: 'user',
        content: JSON.stringify({
          event: input.event,
          approvedContext: input.contextDictionary,
          recentOpenings: input.recentOpenings,
        }),
      },
    ],
    response_format: zodResponseFormat(GeneratedContentSchema, 'generated_content'),
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error('OpenAI returned no parsed structured output');
  return parsed;
}

/**
 * Deterministic safe template used when generation or validation fails twice.
 * The event is never missed because of an AI failure.
 */
export function fallbackTemplate(event: MatchEvent): GeneratedContent {
  const scorer = event.player?.name ?? event.home.name;
  const score = `${event.home.name} ${event.home.score}\u2013${event.away.score} ${event.away.name}`;
  const text: Record<MatchEvent['type'], string> = {
    GOAL: `GOAL — ${scorer}, ${event.minute}'. ${score}. That changes the temperature.`,
    OWN_GOAL: `OWN GOAL — ${scorer}, ${event.minute}'. ${score}. Football can be cruel.`,
    RED_CARD: `RED CARD — ${scorer}, ${event.minute}'. ${score}. Down to ten.`,
    PENALTY_MISSED: `PENALTY MISSED — ${scorer}, ${event.minute}'. ${score}. Chance gone.`,
    VAR: `VAR DECISION — ${event.minute}'. ${score}.`,
    FULL_TIME: `FULL TIME — ${score}.`,
  };
  return {
    postText: text[event.type],
    imagePrompt:
      `Abstract editorial football illustration, stadium lighting, dramatic mood, ` +
      `colour palette inspired by ${event.home.colours.join('/') || event.home.name} and ` +
      `${event.away.colours.join('/') || event.away.name}. No logos, no text, no real faces.`,
    altText:
      `AI-generated editorial football illustration in ${event.home.name} and ${event.away.name} colours. ` +
      `Overlay: ${text[event.type]}`,
    referencedFacts: [scorer, `${event.minute}'`, score],
    risk: 'low',
  };
}
