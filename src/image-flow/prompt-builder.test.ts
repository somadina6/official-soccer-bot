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
    expect(IMAGE_PROMPT_VERSION).toBe('prompt-v8');
  });

  it('uses the player name and authentic kit branding for a goal', () => {
    const prompt = buildEventImagePrompt(base);
    expect(prompt).toContain('Erling Haaland');
    expect(prompt).toContain('Manchester City');
    expect(prompt).toContain('club crest');
    expect(prompt).toContain('sponsor logos');
    expect(prompt).toContain('mid-celebration immediately after scoring');
    expect(prompt).not.toContain('without logos');
    expect(prompt).not.toContain('No club crests');
    expect(prompt).not.toContain('1 – 0');
  });

  it('frames the goal as a tight close-up on a single hero subject', () => {
    const prompt = buildEventImagePrompt(base);
    expect(prompt).toContain('chest-up framing');
    expect(prompt).toContain('single clear hero of the frame');
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
    expect(buildEventImagePrompt({ ...base, type: 'FULL_TIME' })).toContain('Full-time result graphic');
    expect(buildEventImagePrompt({ ...base, type: 'OWN_GOAL' })).toContain('anguish and disbelief');
  });

  it('credits the own goal to the benefiting side, not the scorer\'s side', () => {
    const prompt = buildEventImagePrompt({ ...base, type: 'OWN_GOAL' });
    expect(prompt).toContain('Erling Haaland');
    expect(prompt).not.toContain('celebrating immediately after scoring');
  });

  it('describes goal scoreline drama: opener, equalizer, go-ahead, and lead extension', () => {
    const opener = buildEventImagePrompt({ ...base, home: { ...base.home, score: 1 }, away: { ...base.away, score: 0 } });
    expect(opener).toContain('opening goal of the match');

    const equalizer = buildEventImagePrompt({ ...base, home: { ...base.home, score: 1 }, away: { ...base.away, score: 1 } });
    expect(equalizer).toContain('levels the score at 1-1');

    const goAhead = buildEventImagePrompt({ ...base, home: { ...base.home, score: 2 }, away: { ...base.away, score: 1 } });
    expect(goAhead).toContain('puts Manchester City ahead 2-1');

    const extend = buildEventImagePrompt({ ...base, home: { ...base.home, score: 3 }, away: { ...base.away, score: 1 } });
    expect(extend).toContain("extends Manchester City's lead to 3-1");
  });

  it('credits an own goal scoreline to the benefiting side', () => {
    const equalizer = buildEventImagePrompt({
      ...base,
      type: 'OWN_GOAL',
      home: { ...base.home, score: 1 },
      away: { ...base.away, score: 1 },
    });
    expect(equalizer).toContain('own goal levels the score at 1-1');

    const goAhead = buildEventImagePrompt({
      ...base,
      type: 'OWN_GOAL',
      home: { ...base.home, score: 2 },
      away: { ...base.away, score: 1 },
    });
    expect(goAhead).toContain('own goal puts Manchester City ahead 2-1');
  });

  it('names both clubs on VAR and full-time prompts', () => {
    const varPrompt = buildEventImagePrompt({ ...base, type: 'VAR' });
    expect(varPrompt).toContain('Manchester City');
    expect(varPrompt).toContain('Arsenal');
    expect(varPrompt).toContain('club crests');

    const fullTime = buildEventImagePrompt({ ...base, type: 'FULL_TIME' });
    expect(fullTime).toContain('Manchester City');
    expect(fullTime).toContain('Arsenal');
    expect(fullTime).toContain('club crest');
    expect(fullTime).toContain('no players, no people');
  });

  it('describes stoppage-time drama when a stoppage minute is present', () => {
    const prompt = buildEventImagePrompt({ ...base, minute: 90, stoppageMinute: 4 });
    expect(prompt).toContain("90+4'");
    expect(prompt).toContain('stoppage-time finish');
  });

  it('describes an early or late match moment based on the minute', () => {
    expect(buildEventImagePrompt({ ...base, minute: 5 })).toContain('early in the match');
    expect(buildEventImagePrompt({ ...base, minute: 85 })).toContain('late in the match');
    expect(buildEventImagePrompt({ ...base, minute: 45 })).toContain('hard-fought match');
  });

  it('credits the assist on a goal when one is known', () => {
    const prompt = buildEventImagePrompt({ ...base, assist: { name: 'Kevin De Bruyne' } });
    expect(prompt).toContain('Kevin De Bruyne supplied the assist');
  });

  it('omits assist wording when no assist is known', () => {
    const prompt = buildEventImagePrompt(base);
    expect(prompt).not.toContain('supplied the assist');
  });

  it('weaves the team colours into the kit description', () => {
    const prompt = buildEventImagePrompt(base);
    expect(prompt).toContain('#6CADDF');
  });

  it('varies the full-time mood with the scoreline margin', () => {
    const draw = buildEventImagePrompt({ ...base, type: 'FULL_TIME', home: { ...base.home, score: 1 }, away: { ...base.away, score: 1 } });
    expect(draw).toContain('ends level');

    const rout = buildEventImagePrompt({ ...base, type: 'FULL_TIME', home: { ...base.home, score: 4 }, away: { ...base.away, score: 0 } });
    expect(rout).toContain('dominant, one-sided');

    const narrow = buildEventImagePrompt({ ...base, type: 'FULL_TIME', home: { ...base.home, score: 2 }, away: { ...base.away, score: 1 } });
    expect(narrow).toContain('narrowly decided');
  });

  it('shows both crests and no players, leaving the scoreline to the deterministic overlay', () => {
    const prompt = buildEventImagePrompt({ ...base, type: 'FULL_TIME', home: { ...base.home, score: 2 }, away: { ...base.away, score: 1 } });
    expect(prompt).toContain('#6CADDF');
    expect(prompt).toContain('deterministic overlay');
    expect(prompt).not.toContain('celebrating');
    expect(prompt).not.toContain('"2 - 1"');
  });
});
