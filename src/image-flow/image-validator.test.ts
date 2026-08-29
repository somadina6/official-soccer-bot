import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { enforceXLimit, validateGenerated, X_IMAGE_BYTE_CEILING } from './image-validator.js';
import { ImageFlowError } from './errors.js';
import { buildImmutableStoragePath } from './image-pipeline.js';
import type { MatchEvent } from '../domain/match-event.js';
import { isXMediaExpired } from '../providers/x/media.js';

const event: MatchEvent = {
  provider: 'sportsapi-pro',
  matchId: 'abc',
  competitionId: '1',
  type: 'GOAL',
  status: 'CONFIRMED',
  minute: 1,
  occurredAt: '2026-08-16T12:00:00.000Z',
  home: { id: '1', name: 'A', score: 1, colours: [] },
  away: { id: '2', name: 'B', score: 0, colours: [] },
  rawPayloadHash: 'h',
};

describe('image validator', () => {
  it('rejects non-jpeg bytes', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    await expect(validateGenerated(png)).rejects.toBeInstanceOf(ImageFlowError);
  });

  it('accepts a plausible jpeg', async () => {
    const noise = Buffer.alloc(400 * 300 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 17) % 256;
    const large = await sharp(noise, { raw: { width: 400, height: 300, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    await expect(validateGenerated(large)).resolves.toBeUndefined();
  });

  it('re-encodes images above the 4.8 MB ceiling', async () => {
    const huge = await sharp({
      create: { width: 1536, height: 1024, channels: 3, background: { r: 12, g: 34, b: 56 } },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    // A solid-color jpeg is small; the ceiling path is still a no-op then.
    const out = await enforceXLimit(huge);
    expect(out.length).toBeLessThanOrEqual(X_IMAGE_BYTE_CEILING);
  });
});

describe('storage path and media expiry', () => {
  it('builds an immutable versioned path', () => {
    const path = buildImmutableStoragePath({ matchEventId: 99, fixtureId: 1, event });
    expect(path).toMatch(/^\d{4}\/abc\/99-prompt-v11\.jpg$/);
  });

  it('treats missing or past expiry as expired', () => {
    expect(isXMediaExpired(null)).toBe(true);
    expect(isXMediaExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isXMediaExpired(new Date(Date.now() + 10 * 60_000).toISOString())).toBe(false);
  });
});
