import { describe, expect, it } from 'vitest';
import type { MatchEvent } from '../../domain/match-event.js';
import { fallbackTemplate } from './commentary.js';
import { validateContent } from '../../services/content-policy.js';
import { classifySituation } from '../../services/commentary-situation.js';

function event(overrides: Partial<MatchEvent> & Pick<MatchEvent, 'type'>): MatchEvent {
  return {
    provider: 'sportsapi-pro',
    matchId: '1',
    incidentId: 'inc-1',
    competitionId: '1',
    status: 'CONFIRMED',
    minute: 67,
    occurredAt: '2026-08-15T15:30:00.000Z',
    home: { id: '1', name: 'Arsenal', score: 2, colours: ['#EF0107'] },
    away: { id: '2', name: 'Chelsea', score: 1, colours: ['#034694'] },
    player: { id: '10', name: 'Saka' },
    rawPayloadHash: 'abc',
    ...overrides,
  };
}

const artworkOk = (content: ReturnType<typeof fallbackTemplate>, match: MatchEvent, context: string[] = []) => {
  const situation = classifySituation(match, context);
  const result = validateContent(content, match, [], context, { situation, style: 'punchy' });
  expect(result).toEqual({ valid: true });
  expect(content.postText).toContain('\n');
  expect(content.altText.length).toBeGreaterThan(0);
};

describe('fallbackTemplate', () => {
  it('passes validation for a routine goal', () => {
    const match = event({ type: 'GOAL' });
    artworkOk(fallbackTemplate(match), match);
  });

  it('passes validation for an equalizer', () => {
    const match = event({
      type: 'GOAL',
      minute: 82,
      home: { id: '1', name: 'Aston Villa', score: 2, colours: [] },
      away: { id: '2', name: 'Newcastle', score: 2, colours: [] },
      player: { id: '9', name: 'Watkins' },
    });
    artworkOk(fallbackTemplate(match), match);
  });

  it('passes validation for a late winner with stoppage time', () => {
    const match = event({
      type: 'GOAL',
      minute: 90,
      stoppageMinute: 3,
    });
    artworkOk(fallbackTemplate(match), match);
  });

  it('passes validation for a red card that names the player', () => {
    const match = event({ type: 'RED_CARD', minute: 61, player: { id: '1', name: 'Rice' } });
    const content = fallbackTemplate(match);
    expect(content.postText.toLowerCase()).toContain('rice');
    artworkOk(content, match);
  });

  it('names the keeper, not the taker, for a saved penalty', () => {
    const match = event({
      type: 'PENALTY_MISSED',
      minute: 78,
      player: { id: '9', name: 'Haaland' },
      home: { id: '1', name: 'Everton', score: 1, colours: [] },
      away: { id: '2', name: 'Arsenal', score: 0, colours: [] },
    });
    const context = ['penalty saved', 'goalkeeper Pickford'];
    const content = fallbackTemplate(match, context);
    expect(content.postText).toContain('Pickford');
    expect(content.postText).not.toContain('Haaland');
    artworkOk(content, match, context);
  });

  it('passes validation for a missed penalty, VAR, own goal and full time', () => {
    const missed = event({ type: 'PENALTY_MISSED', minute: 78 });
    artworkOk(fallbackTemplate(missed), missed);

    const own = event({
      type: 'OWN_GOAL',
      minute: 40,
      home: { id: '1', name: 'Arsenal', score: 0, colours: [] },
      away: { id: '2', name: 'Chelsea', score: 1, colours: [] },
    });
    artworkOk(fallbackTemplate(own), own);

    const varEvent = event({ type: 'VAR', minute: 67 });
    artworkOk(fallbackTemplate(varEvent), varEvent);

    const ft = event({ type: 'FULL_TIME', minute: 90 });
    artworkOk(fallbackTemplate(ft), ft);
  });
});
