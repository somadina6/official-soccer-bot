import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { MatchEvent } from '../domain/match-event.js';
import { composeEventImage, solidFallbackBackground } from './visual-composer.js';

const event: MatchEvent = {
  provider: 'sportsapi-pro',
  matchId: '14109842',
  competitionId: '1',
  type: 'GOAL',
  status: 'CONFIRMED',
  minute: 67,
  occurredAt: '2026-08-15T15:30:00.000Z',
  home: { id: '1', name: 'Arsenal', score: 2, colours: ['#EF0107'] },
  away: { id: '2', name: 'Chelsea', score: 1, colours: ['#034694'] },
  player: { id: '10', name: 'Saka' },
  rawPayloadHash: 'abc',
};

describe('visual composer', () => {
  it('renders a 1024×1024 WebP with the deterministic overlay', async () => {
    const background = await solidFallbackBackground(['#EF0107', '#034694']);
    const image = await composeEventImage(background, event);
    const meta = await sharp(image).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(1024);
  });

  it('escapes XML-sensitive characters in names', async () => {
    const background = await solidFallbackBackground([]);
    const tricky = {
      ...event,
      home: { ...event.home, name: 'AT&T <United> "FC"' },
    };
    await expect(composeEventImage(background, tricky)).resolves.toBeInstanceOf(Buffer);
  });
});
