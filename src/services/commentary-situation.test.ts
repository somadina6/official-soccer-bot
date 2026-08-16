import { describe, expect, it } from 'vitest';
import type { MatchEvent } from '../domain/match-event.js';
import { classifySituation, requiresPlayerName } from './commentary-situation.js';

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

describe('classifySituation', () => {
  it('classifies a routine goal', () => {
    expect(classifySituation(event({ type: 'GOAL' }))).toBe('goal');
  });

  it('classifies an equalizer from a level scoreline', () => {
    expect(
      classifySituation(
        event({
          type: 'GOAL',
          minute: 82,
          home: { id: '1', name: 'Aston Villa', score: 2, colours: [] },
          away: { id: '2', name: 'Newcastle', score: 2, colours: [] },
        }),
      ),
    ).toBe('equalizer');
  });

  it('classifies a late winner when the scores differ by one after 85 minutes', () => {
    expect(
      classifySituation(
        event({
          type: 'GOAL',
          minute: 90,
          stoppageMinute: 3,
          home: { id: '1', name: 'Arsenal', score: 2, colours: [] },
          away: { id: '2', name: 'Chelsea', score: 1, colours: [] },
        }),
      ),
    ).toBe('late_winner');
  });

  it('does not treat first-half stoppage as a late winner', () => {
    expect(
      classifySituation(
        event({
          type: 'GOAL',
          minute: 45,
          stoppageMinute: 2,
          home: { id: '1', name: 'Arsenal', score: 1, colours: [] },
          away: { id: '2', name: 'Chelsea', score: 0, colours: [] },
        }),
      ),
    ).toBe('goal');
  });

  it('classifies a late insurance goal as a regular goal', () => {
    expect(
      classifySituation(
        event({
          type: 'GOAL',
          minute: 88,
          home: { id: '1', name: 'Arsenal', score: 3, colours: [] },
          away: { id: '2', name: 'Chelsea', score: 1, colours: [] },
        }),
      ),
    ).toBe('goal');
  });

  it('prefers equalizer over late winner when the scores are level', () => {
    expect(
      classifySituation(
        event({
          type: 'GOAL',
          minute: 90,
          home: { id: '1', name: 'Arsenal', score: 2, colours: [] },
          away: { id: '2', name: 'Chelsea', score: 2, colours: [] },
        }),
      ),
    ).toBe('equalizer');
  });

  it('classifies an own goal that is not levelling or late', () => {
    expect(
      classifySituation(
        event({
          type: 'OWN_GOAL',
          minute: 40,
          home: { id: '1', name: 'Arsenal', score: 0, colours: [] },
          away: { id: '2', name: 'Chelsea', score: 1, colours: [] },
        }),
      ),
    ).toBe('own_goal');
  });

  it('classifies red cards, VAR and full time', () => {
    expect(classifySituation(event({ type: 'RED_CARD' }))).toBe('red_card');
    expect(classifySituation(event({ type: 'VAR' }))).toBe('var_overturn');
    expect(classifySituation(event({ type: 'FULL_TIME', minute: 90 }))).toBe('full_time');
  });

  it('distinguishes a saved penalty from a miss via approved facts', () => {
    const missed = event({ type: 'PENALTY_MISSED', minute: 78 });
    expect(classifySituation(missed)).toBe('penalty_missed');
    expect(classifySituation(missed, ['penalty saved'])).toBe('penalty_saved');
  });
});

describe('requiresPlayerName', () => {
  it('requires a scorer for goals and a taker for a missed penalty', () => {
    expect(requiresPlayerName('goal')).toBe(true);
    expect(requiresPlayerName('equalizer')).toBe(true);
    expect(requiresPlayerName('late_winner')).toBe(true);
    expect(requiresPlayerName('own_goal')).toBe(true);
    expect(requiresPlayerName('penalty_missed')).toBe(true);
  });

  it('does not require a player for red cards, saves, VAR or full time', () => {
    expect(requiresPlayerName('red_card')).toBe(false);
    expect(requiresPlayerName('penalty_saved')).toBe(false);
    expect(requiresPlayerName('var_overturn')).toBe(false);
    expect(requiresPlayerName('full_time')).toBe(false);
  });
});
