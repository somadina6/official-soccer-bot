import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { MatchEvent } from '../domain/match-event.js';
import {
  composeEventImage,
  escapeXml,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  solidFallbackBackground,
  truncateLabel,
} from './visual-composer.js';

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
  it('renders a 1536×1024 JPEG with the deterministic overlay', async () => {
    const background = await solidFallbackBackground(['#EF0107', '#034694']);
    const image = await composeEventImage(background, event);
    const meta = await sharp(image).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(IMAGE_WIDTH);
    expect(meta.height).toBe(IMAGE_HEIGHT);
  });

  it('skips the code-drawn overlay when overlay is false, leaving the model-drawn photo untouched', async () => {
    const background = await solidFallbackBackground(['#ffcc00', '#ffcc00']);
    const withOverlay = await composeEventImage(background, event, { overlay: true });
    const withoutOverlay = await composeEventImage(background, event, { overlay: false });

    const overlaidTopLeft = await sharp(withOverlay).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    const plainTopLeft = await sharp(withoutOverlay).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();

    // With the overlay, the top-left pixel is inside the dark navy scoreboard bar.
    expect(overlaidTopLeft[0]).toBeLessThan(30);
    // Without it, the top-left pixel is the model's own (here: solid yellow) background.
    expect(plainTopLeft[0]).toBeGreaterThan(200);
  });

  it('escapes XML-sensitive characters in names', async () => {
    const background = await solidFallbackBackground([]);
    const tricky = {
      ...event,
      home: { ...event.home, name: 'AT&T <United> "FC"' },
      player: { id: '10', name: "O'Brien & sons" },
    };
    await expect(composeEventImage(background, tricky)).resolves.toBeInstanceOf(Buffer);
    expect(escapeXml(`O'Brien & <x>`)).toBe('O&apos;Brien &amp; &lt;x&gt;');
  });

  it('truncates very long player and team names', async () => {
    const background = await solidFallbackBackground([]);
    const long = {
      ...event,
      player: { id: '10', name: 'A Very Long Player Name That Would Overflow The Overlay' },
      home: { ...event.home, name: 'Wolverhampton Wanderers Athletic Club' },
    };
    const image = await composeEventImage(background, long);
    const meta = await sharp(image).metadata();
    expect(meta.format).toBe('jpeg');
    expect(truncateLabel('Wolverhampton Wanderers Athletic Club', 22).endsWith('…')).toBe(true);
  });

  it('composites a full-time scorers list alongside the deterministic overlay', async () => {
    const background = await solidFallbackBackground(['#EF0107', '#034694']);
    const fullTime = { ...event, type: 'FULL_TIME' as const };
    const image = await composeEventImage(background, fullTime, {
      scorers: [
        { name: 'Saka', minute: 23, side: 'home', ownGoal: false },
        { name: "N'Golo Kanté", minute: 90, stoppageMinute: 3, side: 'away', ownGoal: false },
      ],
    });
    const meta = await sharp(image).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('renders the real competition name on the divider, falling back to Premier League when absent', async () => {
    const background = await solidFallbackBackground([]);
    const faCup = { ...event, type: 'FULL_TIME' as const, competitionName: 'FA Cup' };
    await expect(composeEventImage(background, faCup)).resolves.toBeInstanceOf(Buffer);

    const noName = { ...event, type: 'FULL_TIME' as const, competitionName: undefined };
    await expect(composeEventImage(background, noName)).resolves.toBeInstanceOf(Buffer);
  });

  it('draws no scorers backdrop when the list is empty', async () => {
    const background = await solidFallbackBackground([]);
    const fullTime = { ...event, type: 'FULL_TIME' as const };
    await expect(
      composeEventImage(background, fullTime, { scorers: [] }),
    ).resolves.toBeInstanceOf(Buffer);
  });

  async function crestPng(color: { r: number; g: number; b: number }): Promise<Buffer> {
    return sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
      .png()
      .toBuffer();
  }

  it('composites both real crests when provided', async () => {
    const background = await solidFallbackBackground(['#0057B8', '#EF0107']);
    const fullTime = { ...event, type: 'FULL_TIME' as const };
    const crests = {
      home: await crestPng({ r: 0, g: 87, b: 184 }),
      away: await crestPng({ r: 239, g: 1, b: 7 }),
    };
    const image = await composeEventImage(background, fullTime, { crests });
    const meta = await sharp(image).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(IMAGE_WIDTH);
  });

  it('composites whichever crest resolved when only one side is available', async () => {
    const background = await solidFallbackBackground([]);
    const fullTime = { ...event, type: 'FULL_TIME' as const };
    const crests = { home: await crestPng({ r: 10, g: 20, b: 30 }), away: null };
    const image = await composeEventImage(background, fullTime, { crests });
    const meta = await sharp(image).metadata();
    expect(meta.format).toBe('jpeg');
  });
});
