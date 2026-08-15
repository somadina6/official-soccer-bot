import { createHash } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import type { MatchEvent } from '../domain/match-event.js';
import { logger } from '../observability/logger.js';
import {
  fixtureBackgroundPrompt,
  generateBackground,
  type BackgroundKind,
} from '../providers/openai/artwork.js';
import { getSupabase } from '../supabase/client.js';
import { solidFallbackBackground } from './visual-composer.js';

/**
 * Hybrid image strategy (section 8): three square editorial backgrounds are
 * generated per fixture 30–60 minutes before kick-off, so live events render
 * in sub-second time with sharp. Backgrounds are cached in memory and, when a
 * bucket is configured, retained in private Storage for reuse across restarts.
 */

const memoryCache = new Map<string, Buffer>();

const cacheKey = (fixtureId: number, kind: BackgroundKind) => `${fixtureId}:${kind}`;

function storagePath(fixtureId: number, kind: BackgroundKind): string {
  return `backgrounds/${fixtureId}/${kind}.webp`;
}

export async function prepareFixtureBackgrounds(fixtureId: number): Promise<void> {
  const supabase = getSupabase();
  const { data: fixture, error } = await supabase
    .from('fixtures')
    .select('id, home_team, away_team, prepared_backgrounds')
    .eq('id', fixtureId)
    .single();
  if (error || !fixture) throw new Error(`fixture ${fixtureId} not found: ${error?.message}`);

  const home = (fixture.home_team ?? {}) as { name?: string; colours?: string[] };
  const away = (fixture.away_team ?? {}) as { name?: string; colours?: string[] };
  const prepared = (fixture.prepared_backgrounds ?? {}) as Record<string, string>;

  const kinds: BackgroundKind[] = ['home-momentum', 'away-momentum', 'drama'];
  const env = loadEnv();

  for (const kind of kinds) {
    if (prepared[kind] && memoryCache.has(cacheKey(fixtureId, kind))) continue;

    const prompt = fixtureBackgroundPrompt({
      kind,
      homeName: home.name ?? 'the home side',
      awayName: away.name ?? 'the away side',
      homeColours: home.colours ?? [],
      awayColours: away.colours ?? [],
    });

    const image = await generateBackground(prompt);
    memoryCache.set(cacheKey(fixtureId, kind), image);

    let path: string | null = null;
    if (env.SUPABASE_STORAGE_BUCKET) {
      path = storagePath(fixtureId, kind);
      const { error: uploadError } = await supabase.storage
        .from(env.SUPABASE_STORAGE_BUCKET)
        .upload(path, image, { contentType: 'image/webp', upsert: true });
      if (uploadError) {
        logger.warn({ path, error: uploadError.message }, 'background retention failed');
        path = null;
      }
    }

    await supabase.from('media_assets').insert({
      fixture_id: fixtureId,
      kind: 'prepared_background',
      storage_path: path,
      image_hash: createHash('sha256').update(image).digest('hex'),
    });
    prepared[kind] = path ?? 'memory';
  }

  await supabase
    .from('fixtures')
    .update({ prepared_backgrounds: prepared, updated_at: new Date().toISOString() })
    .eq('id', fixtureId);
  logger.info({ fixtureId }, 'fixture backgrounds prepared');
}

function kindForEvent(event: MatchEvent): BackgroundKind {
  if (event.type === 'GOAL' || event.type === 'OWN_GOAL') {
    // Own goals credit the conceding side's mishap; the scoreboard decides mood.
    const homeScored = event.type === 'GOAL' ? event.home.score >= event.away.score : false;
    return homeScored ? 'home-momentum' : 'away-momentum';
  }
  return 'drama';
}

/**
 * Resolves the background for a live event without ever blocking on a fresh
 * image-model request: memory cache → Storage → deterministic solid gradient.
 */
export async function getBackgroundForEvent(
  fixtureId: number,
  event: MatchEvent,
): Promise<Buffer> {
  const kind = kindForEvent(event);
  const cached = memoryCache.get(cacheKey(fixtureId, kind));
  if (cached) return cached;

  const env = loadEnv();
  if (env.SUPABASE_STORAGE_BUCKET) {
    const { data } = await getSupabase()
      .storage.from(env.SUPABASE_STORAGE_BUCKET)
      .download(storagePath(fixtureId, kind));
    if (data) {
      const buffer = Buffer.from(await data.arrayBuffer());
      memoryCache.set(cacheKey(fixtureId, kind), buffer);
      return buffer;
    }
  }

  logger.warn({ fixtureId, kind }, 'no prepared background; using solid fallback');
  return solidFallbackBackground([...event.home.colours, ...event.away.colours]);
}

/**
 * Enqueue-side helper: fixtures kicking off within the next 60 minutes whose
 * backgrounds have not been prepared yet.
 */
export async function fixturesNeedingBackgrounds(): Promise<number[]> {
  const now = Date.now();
  const { data, error } = await getSupabase()
    .from('fixtures')
    .select('id, prepared_backgrounds')
    .in('status', ['scheduled', 'live'])
    .gte('starts_at', new Date(now - 30 * 60_000).toISOString())
    .lte('starts_at', new Date(now + 60 * 60_000).toISOString());
  if (error) throw new Error(`background candidate query failed: ${error.message}`);

  return (data ?? [])
    .filter(row => {
      const prepared = (row.prepared_backgrounds ?? {}) as Record<string, string>;
      return !prepared['home-momentum'] || !prepared['away-momentum'] || !prepared['drama'];
    })
    .map(row => row.id as number);
}
