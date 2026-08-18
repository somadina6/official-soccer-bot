import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { loadEnv } from "../../config/env.js";
import {
  InfluencerPostOutputSchema,
  extractHook,
  type ContentGenerationInput,
  type ContentIntent,
  type InfluencerPostOutput,
} from "../../domain/content.js";
import { logger } from "../../observability/logger.js";
import { STYLE_GUIDANCE } from "../../services/commentary-style.js";
import { TONE_GUIDANCE } from "./commentary.js";
import { MATCHMOUTH_IDENTITY } from "./identity.js";

let client: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (client) return client;
  client = new OpenAI({ apiKey: loadEnv().OPENAI_API_KEY });
  return client;
}

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
].join(", ");

const INTENT_GUIDANCE: Record<Exclude<ContentIntent, "live_reaction">, string> = {
  post_match_verdict:
    "Write a post-match verdict. React to the finished result with a clear take on the performance, not a recap.",
  hot_take:
    "Write a hot take about the supplied player or team. Strong opinions are the point; they must stay recognisable as opinions.",
  prediction:
    "Write a pre-match prediction. Take a side. This prediction will be stored and checked after full time.",
  question:
    "Ask one genuine football discussion question grounded in the supplied match facts.",
  receipt:
    "Evaluate the stored prediction against the verified result. First person is allowed because the prediction is real stored memory, not invented.",
};

export function influencerPolicy(
  input: Exclude<ContentGenerationInput, { intent: "live_reaction" }>,
): string {
  return [
    MATCHMOUTH_IDENTITY,
    "",
    "You write scheduled MatchMouth posts for X. This is not a live incident reaction.",
    "",
    "STRUCTURE:",
    "- Produce exactly two distinct candidates.",
    "- Every candidate must contain exactly four compact lines:",
    "  hook — an immediate emotional reaction, normally 2–8 words.",
    "  factLine — the verified match or fixture fact, written in active language.",
    "  opinion — a clear, recognisable opinion. Career-wide conclusions are allowed here.",
    "  punchline — one sharp observation, callback or piece of banter.",
    "- The published post is those four lines joined with newline characters.",
    "- Target 160–250 characters per candidate. Absolute maximum: 280.",
    "- Candidate one: confident primary take.",
    "- Candidate two: a different angle on the same facts.",
    "",
    `Target tone: ${input.tone}. ${TONE_GUIDANCE[input.tone]}`,
    `Assigned style for both candidates: ${input.style}. ${STYLE_GUIDANCE[input.style]}`,
    `Content intent: ${input.intent}. ${INTENT_GUIDANCE[input.intent]}`,
    "",
    "FACTS AND OPINIONS:",
    "- Every factual assertion must be supported by the supplied data.",
    "- Strong opinions are allowed, but they must be recognizable as opinions.",
    "- Career-wide conclusions are allowed as opinions, including history-level judgements.",
    "- Do not present a career-wide conclusion as a verified statistic.",
    "- Exaggerate emotion, never factual claims.",
    "- Never invent statistics, transfer news, injuries, dressing-room conflict or quotations.",
    "- Established takes supplied by the user are your real prior opinions. Refer to them; do not invent new history.",
    "",
    "FORMATTING:",
    "- Use zero or one emoji normally.",
    "- Two emojis are allowed only when the assigned style is dramatic.",
    "- No URLs, hashtags or unsolicited @mentions.",
    "- Use plain player and team names.",
    `- Never use these clichés: ${BANNED_CLICHE_PROMPT}.`,
    "",
    "SAFETY:",
    "- Never target identity, protected characteristics, appearance, injury, disability, tragedy or personal circumstances.",
    "- No slurs, threats, sexual content or dehumanizing abuse.",
    "- No referee-corruption, match-fixing or intentional-injury allegations.",
    '- Set risk to "review" if wording could reasonably be considered borderline.',
    '- Set risk to "reject" only if you cannot produce a safe alternative.',
  ].join("\n");
}

function userPayload(
  input: Exclude<ContentGenerationInput, { intent: "live_reaction" }>,
): Record<string, unknown> {
  const shared = {
    intent: input.intent,
    tone: input.tone,
    style: input.style,
    approvedFacts: input.approvedFacts,
    recentOpenings: input.recentOpenings.map(extractHook),
  };

  switch (input.intent) {
    case "post_match_verdict":
      return { ...shared, match: input.match };
    case "hot_take":
      return { ...shared, subject: input.subject };
    case "prediction":
      return { ...shared, fixture: input.fixture };
    case "question":
      return { ...shared, match: input.match };
    case "receipt":
      return { ...shared, prediction: input.prediction, result: input.result };
  }
}

export async function generateInfluencerPost(
  input: Exclude<ContentGenerationInput, { intent: "live_reaction" }>,
): Promise<InfluencerPostOutput> {
  const env = loadEnv();

  logger.debug(
    { intent: input.intent, style: input.style, tone: input.tone },
    "generating influencer post",
  );

  const completion = await getOpenAI().beta.chat.completions.parse({
    model: env.OPENAI_TEXT_MODEL,
    messages: [
      { role: "system", content: influencerPolicy(input) },
      { role: "user", content: JSON.stringify(userPayload(input)) },
    ],
    response_format: zodResponseFormat(
      InfluencerPostOutputSchema,
      "influencer_content",
    ),
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("OpenAI returned no parsed structured output");
  }
  return parsed;
}
