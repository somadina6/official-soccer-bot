import { loadEnv } from '../config/env.js';
import {
  generateEventArtwork as generateOpenAIArtwork,
  type GeneratedArtwork,
} from './gpt-image.generator.js';
import { generateReplicateArtwork } from './replicate-image.generator.js';

export type { GeneratedArtwork };

/**
 * Routes per-event artwork generation to OpenAI or Replicate based on
 * IMAGE_PROVIDER. Both implementations return a JPEG buffer for compositing.
 */
export async function generateEventArtwork(prompt: string): Promise<GeneratedArtwork> {
  if (loadEnv().IMAGE_PROVIDER === 'replicate') {
    return generateReplicateArtwork(prompt);
  }
  return generateOpenAIArtwork(prompt);
}
