import { generateEventArtwork } from '../image-flow/generate-event-artwork.js';
import { validateGenerated } from '../image-flow/image-validator.js';
import { logger } from '../observability/logger.js';
import { downloadArtwork, storeArtwork } from '../supabase/storage.js';

/**
 * Generic backdrop for the full-time score card. Now that crests, team
 * names, score, competition label, and the scorers list are all composited
 * from real data (see services/crests.ts, visual-composer.ts), the model's
 * only remaining job for FULL_TIME was a decorative stadium blur with no
 * match-specific content — not worth a fresh, non-deterministic AI call
 * per event (cost, latency, and the odd stray hallucinated crest/text we
 * saw in testing). So it's generated once and cached under a date-keyed
 * storage path: a new UTC day naturally invalidates the cache, giving a
 * 24-hour TTL with no separate expiry bookkeeping.
 */
const BACKDROP_PROMPT = `
Vertical portrait orientation. A subtly blurred, floodlit stadium
photograph background: an empty pitch, no players, no people, no crowd
faces in sharp focus, no club crests, badges, or emblems, no text, numbers,
letters, logos, or scoreboards of any kind anywhere in the image. Punchy
contemporary sports colour grading, cool shadow tones, warm floodlight
highlights. Balanced, centered composition suitable as a calm backdrop for
a full-time result graphic composited on top afterward.
`.trim();

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function backdropObjectPath(dateKey: string): string {
  return `backdrops/full-time-${dateKey}.jpg`;
}

/** Today's cached full-time backdrop, generating and caching a fresh one the first time it's needed each day. */
export async function loadFullTimeBackdrop(): Promise<Buffer> {
  const objectPath = backdropObjectPath(todayUtcKey());

  try {
    return await downloadArtwork(objectPath);
  } catch {
    // Not cached yet today — generate and cache one below.
  }

  const generated = await generateEventArtwork(BACKDROP_PROMPT);
  await validateGenerated(generated.image);
  await storeArtwork({ objectPath, image: generated.image });
  logger.info({ objectPath }, 'generated and cached a fresh full-time backdrop');
  return generated.image;
}
