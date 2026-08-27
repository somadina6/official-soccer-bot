import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { loadEnv } from "../../config/env.js";
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
} from "../../domain/content.js";
import type { MatchEvent } from "../../domain/match-event.js";
import { logger } from "../../observability/logger.js";
import {
  classifySituation,
  SITUATION_GUIDANCE,
} from "../../services/commentary-situation.js";
import { STYLE_GUIDANCE } from "../../services/commentary-style.js";
import { MATCHMOUTH_IDENTITY } from "./identity.js";

let client: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (client) return client;

  client = new OpenAI({
    apiKey: loadEnv().OPENAI_API_KEY,
  });

  return client;
}

export const TONE_GUIDANCE: Record<BanterTone, string> = {
  neutral:
    "High-energy match reaction focused on the quality, pressure and drama of the moment. No teasing, but never dry or clinical.",

  playful:
    "Enthusiastic live reaction with light, unmistakably playful banter about defending, finishing, tactics or the match situation.",

  spicy: [
    "Use bold Football Twitter energy and a sharper incident-specific joke.",
    "Sound shamelessly confident, dramatic and ready for rival replies.",
    "Exaggerate the emotional reaction, never the underlying facts.",
    "Attack the football decision or performance, never the person’s identity,",
    "appearance, injury or private life.",
  ].join(" "),
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
  "footballing gods / eternal symphony / destiny-chapter metaphors",
].join(", ");

export function commentaryPolicy(
  tone: BanterTone,
  style: CommentaryStyle,
  situation: CommentarySituation,
): string {
  const candidateGuidance =
    style === "timeline"
      ? [
          "- Candidate one: explosive timeline reaction.",
          "- Candidate two: shamelessly confident rival-banter angle.",
        ]
      : [
          "- Candidate one: explosive and immediate.",
          "- Candidate two: quick football wit.",
        ];
  return [
    MATCHMOUTH_IDENTITY,
    "",
    "You write immediate Premier League reactions for X.",
    "Make brilliant, shocking or decisive football feel brilliant, shocking or decisive.",
    "",
    "PRIMARY OBJECTIVE:",
    "- Write like a real fan posting from their phone seconds after it happened, not a brand account.",
    "- Make every candidate feel alive, immediate and worth reading.",
    "- Write as if the event happened seconds ago, not as if you are summarizing it afterward.",
    "- Every candidate must express a clear emotion: excitement, disbelief, tension, admiration, shock or playful frustration.",
    "- Use active verbs, confident phrasing, sentence fragments and controlled punctuation.",
    "- Energy means urgency and personality, not invented importance or constant shouting.",
    "- For goals and decisive moments, react first and explain second.",
    "",
    "STRUCTURE:",
    "- Produce exactly two distinct candidates.",
    "- Each candidate has three possible lines: hook, factLine, punchline.",
    "  hook — the reaction itself. Always required, normally 2–8 words.",
    "  factLine — the confirmed player/team, minute and score, written in active language.",
    "  punchline — one sharp, incident-specific observation, reaction or piece of banter.",
    '- factLine and punchline are OPTIONAL: leave either as an empty string "" when the moment plays better as one raw line.',
    "- Default to ONE line (hook only). Add a factLine only when the score or minute genuinely earns the extra line.",
    "  Add a punchline only when there is a genuinely separate joke, not a restatement of the hook.",
    "- Do not pad a post to three lines out of habit — most real fan tweets are one blunt sentence, not a mini-article.",
    "- The published post is the non-empty lines joined by a blank line.",
    "- Target roughly 100–220 characters depending on how many lines you use. Absolute maximum: 280.",
    ...candidateGuidance,
    "- Both must follow the assigned style, but approach the event from different angles.",
    "- Vary how many lines each candidate uses: it looks scripted if both candidates are always three lines.",
    "",
    "HOOKS:",
    "- The hook must sound natural when shouted or spoken aloud during a match.",
    "- One or two candidates may use a short ALL-CAPS hook. Never capitalize an entire post.",
    "- Hooks must communicate a reaction, not merely label the event.",
    "- Do not open goals with GOOOOAL, GOAL!, stretched goal spellings or a bare event label.",
    "- Each candidate must have a genuinely different hook.",
    "- Never reuse a recent opening supplied by the user.",
    "",
    `Target tone: ${tone}. ${TONE_GUIDANCE[tone]}`,
    `Assigned style for both candidates: ${style}. ${STYLE_GUIDANCE[style]}`,
    `Confirmed situation: ${situation}. ${SITUATION_GUIDANCE[situation]}`,
    "",
    "TIMELINE MODE:",
    "- When the assigned style is timeline, prioritize personality over polished commentary.",
    "- React with shameless confidence, playful disbelief or exaggerated certainty.",
    "- The emotional reaction may be dramatic, but every factual statement must remain verified.",
    "- Directly address the team, defence, goalkeeper or match situation when it creates stronger banter.",
    "- Use occasional conversational phrasing, but do not repeat one catchphrase across posts.",
    "- Create reply-worthy tension without manufacturing controversy.",
    "- Do not imitate or name any real social-media creator.",
    "- Do not deliberately post false predictions or claims as engagement bait.",
    "VOICE:",
    "- Sound like a real, slightly unfiltered football fan posting instinctively, not a notification service or a brand account.",
    "- Low filter means blunt, short, occasionally messy sentences over anything that reads composed or corporate.",
    '- A bare reaction with no explanation is a complete, valid post: "CHELSEA WHY", "Not this again.", "We are so back."',
    '- It is fine to address the team directly, second person: "boys, wake up", "sort it out".',
    "- Do not over-explain the joke. Land it in as few words as possible and stop.",
    "- The fact line, when used, may be factual without becoming robotic.",
    '- Prefer active constructions such as "Haaland puts City ahead" over "The score is now 2–1".',
    "- Banter may target defending, finishing, goalkeeping, tactics or the match situation.",
    "- Celebrate excellent football regardless of which team produced it.",
    "- Humour must come from the specific incident, not from a generic or forced joke.",
    "- A vivid metaphor or comparison is optional. Never force one into every candidate.",
    '- Avoid stiff wording such as "has registered a goal", "the player has scored", "the score is now" or "an important event occurred".',
    "",
    "FACTUAL RULES:",
    "- Use only facts present in the event JSON or approved context dictionary.",
    "- Never invent statistics, records, history, motives, quotations or match context.",
    "- Context describing the body part, placement, pitch position, open play versus penalty, penalty outcome or goalkeeper name is verified provider data.",
    "- Use verified context when it makes the post more vivid, but do not force every fact into the copy.",
    "- Never describe an event as a winner, equalizer, comeback, upset or record unless the supplied data confirms it.",
    '- Do not use unsupported superlatives such as "first ever", "greatest ever" or "record-breaking".',
    "",
    "FORMATTING:",
    "- Use zero or one emoji normally.",
    "- Two emojis are allowed only when the assigned style is dramatic.",
    "- Normally use no more than two exclamation marks per candidate.",
    "- No URLs, hashtags or unsolicited @mentions.",
    "- Use plain player and team names.",
    "- Do not ask questions unless the assigned style is question and the situation is full time.",
    "- Use short sentences with natural rhythm.",
    `- Never use these clichés: ${BANNED_CLICHE_PROMPT}.`,
    "- Candidates must differ in both hook and punchline, not merely substitute synonyms.",
    "",
    "SAFETY:",
    "- Never target identity, protected characteristics, appearance, injury, disability, tragedy or personal circumstances.",
    "- No slurs, threats, sexual content or dehumanizing abuse.",
    "- No referee-corruption, match-fixing or intentional-injury allegations.",
    "- Spicy means sharper football banter, not personal hostility.",
    '- Set risk to "review" if wording could reasonably be considered borderline.',
    '- Set risk to "reject" only if you cannot produce a safe, energetic alternative.',
    "",
    "ALT TEXT:",
    "- Produce descriptive alt text separately.",
    "- Describe the visible scene and confirmed overlay facts without adding unverified match details.",
  ].join("\n");
}

export type CommentaryInput = {
  event: MatchEvent;
  tone: BanterTone;
  style: CommentaryStyle;
  situation: CommentarySituation;

  /** Short, operator-approved rivalry/context dictionary. */
  contextDictionary: string[];

  /** Last 20 posts, used to avoid repetitive openings. */
  recentOpenings: string[];
};

/**
 * Generates two schema-constrained commentary candidates.
 *
 * Structured Outputs guarantees the response shape.
 * Factual correctness is enforced separately by the deterministic validator.
 */
export async function generateCommentary(
  input: CommentaryInput,
): Promise<CommentaryModelOutput> {
  const env = loadEnv();

  logger.debug(
    {
      eventId: input.event.matchId,
      situation: input.situation,
      style: input.style,
      tone: input.tone,
    },
    "generating commentary",
  );

  const completion = await getOpenAI().beta.chat.completions.parse({
    model: env.OPENAI_TEXT_MODEL,
    messages: [
      {
        role: "system",
        content: commentaryPolicy(input.tone, input.style, input.situation),
      },
      {
        role: "user",
        content: JSON.stringify({
          event: input.event,
          situation: input.situation,
          style: input.style,
          tone: input.tone,
          approvedContext: input.contextDictionary,
          recentOpenings: input.recentOpenings.map(extractHook),
        }),
      },
    ],
    response_format: zodResponseFormat(
      CommentaryModelOutputSchema,
      "generated_content",
    ),
  });

  const parsed = completion.choices[0]?.message.parsed;

  if (!parsed) {
    throw new Error("OpenAI returned no parsed structured output");
  }

  return parsed;
}

function scoreline(event: MatchEvent): string {
  return (
    `${event.home.name} ${event.home.score}` +
    `\u2013${event.away.score} ${event.away.name}`
  );
}

function keeperName(approvedContext: string[]): string | undefined {
  for (const fact of approvedContext) {
    const match = fact.match(/^goalkeeper\s+(.+)$/i);

    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function minuteLabel(event: MatchEvent): string {
  if (event.stoppageMinute !== undefined && event.stoppageMinute > 0) {
    return `${event.minute}+${event.stoppageMinute}'`;
  }

  return `${event.minute}'`;
}

function fallbackCandidate(
  event: MatchEvent,
  situation: CommentarySituation,
  approvedContext: string[],
): CommentaryCandidate {
  const score = scoreline(event);
  const player = event.player?.name;
  const minute = minuteLabel(event);

  switch (situation) {
    case "equalizer":
      return {
        hook: "WE ARE LEVEL!",
        factLine: player
          ? `${player} pulls it level at ${minute}. ${score}.`
          : `Level at ${minute}. ${score}.`,
        punchline: "Nobody is sitting comfortably now.",
      };

    case "late_winner":
      return {
        hook: "LATE DRAMA!",
        factLine: player
          ? `${player} strikes at ${minute}. ${score}.`
          : `Goal at ${minute}. ${score}.`,
        punchline: "The clock has just become enemy number one.",
      };

    case "own_goal":
      return {
        hook: "OH, NO.",
        factLine: player
          ? `Own goal by ${player} at ${minute}. ${score}.`
          : `Own goal at ${minute}. ${score}.`,
        punchline: "Football has found its cruel side again.",
      };

    case "red_card":
      return {
        hook: "THE MATCH JUST TURNED.",
        factLine: player
          ? `${player} is sent off at ${minute}. ${score}.`
          : `Red card at ${minute}. ${score}.`,
        punchline: "One card and the tactical plan needs a rewrite.",
      };

    case "penalty_saved": {
      const keeper = keeperName(approvedContext);

      return {
        hook: "WHAT A STOP!",
        factLine: keeper
          ? `${keeper} saves the penalty at ${minute}. ${score}.`
          : `Penalty saved at ${minute}. ${score}.`,
        punchline: "The goalkeeper wins that duel emphatically.",
      };
    }

    case "penalty_missed":
      return {
        hook: "THE CHANCE IS GONE.",
        factLine: player
          ? `${player} misses from the spot at ${minute}. ${score}.`
          : `Penalty missed at ${minute}. ${score}.`,
        punchline: "Maximum opportunity. Nothing on the scoreboard.",
      };

    case "var_overturn":
      return {
        hook: "SCRATCH THAT.",
        factLine:
          `The ${minute} goal is overturned. ` +
          `It stays ${event.home.score}\u2013${event.away.score}.`,
        punchline: "The celebration has been cancelled by VAR.",
      };

    case "full_time":
      return {
        hook: "THAT IS THE WHISTLE.",
        factLine: score,
        punchline: "No more arguments. The result is locked in.",
      };

    case "goal":
    default:
      return {
        hook: "IN IT GOES!",
        factLine: player
          ? `${player} scores at ${minute}. ${score}.`
          : `Goal at ${minute}. ${score}.`,
        punchline: "The net has delivered the only explanation needed.",
      };
  }
}

/**
 * Deterministic safe template used when generation or validation fails twice.
 *
 * The event is never missed because of an AI generation failure.
 */
export function fallbackTemplate(
  event: MatchEvent,
  approvedContext: string[] = [],
): GeneratedContent {
  const situation = classifySituation(event, approvedContext);
  const candidate = fallbackCandidate(event, situation, approvedContext);

  const postText = composePostText(candidate);
  const score = scoreline(event);
  const facts = [minuteLabel(event), score];

  if (event.player?.name) {
    facts.unshift(event.player.name);
  }

  return {
    postText,
    altText:
      `Photorealistic editorial football image in ` +
      `${event.home.name} and ${event.away.name} colours. ` +
      `Overlay: ${candidate.factLine}`,
    referencedFacts: facts,
    risk: "low",
  };
}
