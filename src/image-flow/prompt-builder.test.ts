import { describe, expect, it } from 'vitest';
import type { MatchEvent } from '../domain/match-event.js';
import { buildEventImagePrompt, IMAGE_PROMPT_VERSION } from './prompt-builder.js';

const base: MatchEvent = {
  provider: 'sportsapi-pro',
  matchId: '1',
  competitionId: '1',
  type: 'GOAL',
  status: 'CONFIRMED',
  minute: 12,
  occurredAt: '2026-08-16T12:00:00.000Z',
  home: { id: '1', name: 'Manchester City', score: 1, colours: ['#6CADDF'] },
  away: { id: '2', name: 'Arsenal', score: 0, colours: ['#EF0107'] },
  player: { name: 'Erling Haaland' },
  rawPayloadHash: 'h',
};

describe('prompt builder', () => {
  it('pins a versioned prompt identifier', () => {
    expect(IMAGE_PROMPT_VERSION).toBe('prompt-v2');
  });

  it('uses the player name and kit colour for a goal', () => {
    const prompt = buildEventImagePrompt(base);
    expect(prompt).toContain('Erling Haaland');
    expect(prompt).toContain('#6CADDF');
    expect(prompt).toContain('celebrating immediately after scoring');
    expect(prompt).not.toContain('1 – 0');
  });

  it('falls back to generic wording when the player is missing', () => {
    const { player: _player, ...withoutPlayer } = base;
    const prompt = buildEventImagePrompt(withoutPlayer);
    expect(prompt).toContain('a football player');
  });

  it('uses a distinct template per event type', () => {
    expect(buildEventImagePrompt({ ...base, type: 'RED_CARD' })).toContain('sending-off');
    expect(buildEventImagePrompt({ ...base, type: 'PENALTY_MISSED' })).toContain('missed penalty');
    expect(buildEventImagePrompt({ ...base, type: 'VAR' })).toContain('video review');
    expect(buildEventImagePrompt({ ...base, type: 'FULL_TIME' })).toContain('final whistle');
    expect(buildEventImagePrompt({ ...base, type: 'OWN_GOAL' })).toContain('celebrating immediately after scoring');
  });
});
