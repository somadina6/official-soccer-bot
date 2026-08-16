import OpenAI from 'openai';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';

let client: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (client) return client;
  client = new OpenAI({ apiKey: loadEnv().OPENAI_API_KEY });
  return client;
}

export type BackgroundKind = 'home-momentum' | 'away-momentum' | 'drama';

export type FixtureBackgroundInput = {
  kind: BackgroundKind;
  homeName: string;
  awayName: string;
  homeColours: string[];
  awayColours: string[];
};

/**
 * Builds the prompt for one of the three pre-generated fixture backgrounds
 * (hybrid image strategy, section 8). Abstract players and stadium lighting
 * only — no logos, league marks, sponsor marks or recognizable likenesses,
 * and no factual text: score/minute are overlaid deterministically by sharp.
 */
export function fixtureBackgroundPrompt(input: FixtureBackgroundInput): string {
  const palette =
    `${input.homeName} palette (${input.homeColours.join(', ') || 'club colours'}) and ` +
    `${input.awayName} palette (${input.awayColours.join(', ') || 'club colours'})`;
  const mood: Record<BackgroundKind, string> = {
    'home-momentum': `celebratory attacking energy sweeping toward the ${input.homeName} colours`,
    'away-momentum': `celebratory attacking energy sweeping toward the ${input.awayName} colours`,
    drama: 'tense, high-drama atmosphere with sharp contrast and cold spotlight beams',
  };
  return (
    `Square editorial football illustration. Abstract, stylized silhouetted players, ` +
    `dramatic stadium floodlighting, dynamic motion, ${mood[input.kind]}. ` +
    `Colour palette strictly inspired by ${palette}. ` +
    `Absolutely no club crests, no league logos, no sponsor marks, no recognizable player faces, ` +
    `no letters, no numbers, no text of any kind. Leave the lower third calmer for an overlay.`
  );
}

/** Generates one 1024×1024 WebP background. Never call this in the live event
 * path without a strict timeout; prepared backgrounds are the fallback. */
export async function generateBackground(prompt: string): Promise<Buffer> {
  const env = loadEnv();
  logger.info({ prompt }, 'generating background');
  const result = await getOpenAI().images.generate({
    model: env.OPENAI_IMAGE_MODEL,
    prompt,
    size: '1024x1024',
    quality: 'low',
    output_format: 'webp'
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('Image generation returned no data');
  return Buffer.from(b64, 'base64');
}
