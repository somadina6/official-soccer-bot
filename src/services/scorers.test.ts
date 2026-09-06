import { describe, expect, it } from 'vitest';
import type { MatchEvent } from '../domain/match-event.js';
import { deriveFullTimeScorers, type ScorerRow } from './scorers.js';

function row(overrides: {
  eventType: 'GOAL' | 'OWN_GOAL';
  minute: number;
  stoppageMinute?: number;
  playerName?: string;
  homeScore: number;
  awayScore: number;
}): ScorerRow {
  const event = {
    provider: 'sportsapi-pro',
    matchId: '1',
    competitionId: '1',
    type: overrides.eventType,
    status: 'CONFIRMED',
    minute: overrides.minute,
    stoppageMinute: overrides.stoppageMinute,
    occurredAt: '2026-08-16T12:00:00.000Z',
    home: { id: '1', name: 'Everton', score: overrides.homeScore, colours: [] },
    away: { id: '2', name: 'Manchester United', score: overrides.awayScore, colours: [] },
    player: overrides.playerName ? { name: overrides.playerName } : undefined,
    rawPayloadHash: 'h',
  } as MatchEvent;

  return {
    event_type: overrides.eventType,
    minute: overrides.minute,
    stoppage_minute: overrides.stoppageMinute ?? null,
    normalized: event,
  };
}

describe('deriveFullTimeScorers', () => {
  it('credits each goal to the side whose score increased, in minute order', () => {
    const rows = [
      row({ eventType: 'GOAL', minute: 46, playerName: 'B. Mbeumo', homeScore: 0, awayScore: 1 }),
      row({ eventType: 'GOAL', minute: 83, playerName: 'T. George', homeScore: 1, awayScore: 1 }),
      row({ eventType: 'GOAL', minute: 88, playerName: 'B. Sesko', homeScore: 1, awayScore: 2 }),
      row({
        eventType: 'GOAL',
        minute: 90,
        stoppageMinute: 6,
        playerName: 'A. Maitland-Niles',
        homeScore: 2,
        awayScore: 2,
      }),
    ];

    const scorers = deriveFullTimeScorers(rows);

    expect(scorers.map(s => s.name)).toEqual([
      'B. Mbeumo',
      'T. George',
      'B. Sesko',
      'A. Maitland-Niles',
    ]);
    expect(scorers.map(s => s.side)).toEqual(['away', 'home', 'away', 'home']);
  });

  it('sorts out-of-order rows by minute and stoppage minute', () => {
    const rows = [
      row({ eventType: 'GOAL', minute: 88, playerName: 'B. Sesko', homeScore: 0, awayScore: 1 }),
      row({ eventType: 'GOAL', minute: 46, playerName: 'B. Mbeumo', homeScore: 0, awayScore: 1 }),
    ];

    // Both entries score the away side's first goal; the second is a data
    // artifact here, but ordering must still put minute 46 before minute 88.
    const scorers = deriveFullTimeScorers([rows[0]!, rows[1]!]);
    expect(scorers[0]?.name).toBe('B. Mbeumo');
  });

  it('credits an own goal to the benefiting side and flags it', () => {
    const rows = [row({ eventType: 'OWN_GOAL', minute: 12, playerName: 'D. Defender', homeScore: 1, awayScore: 0 })];
    const scorers = deriveFullTimeScorers(rows);
    expect(scorers).toEqual([
      { name: 'D. Defender', minute: 12, stoppageMinute: undefined, side: 'home', ownGoal: true },
    ]);
  });

  it('skips rows with no known scorer name or no score change', () => {
    const rows = [
      row({ eventType: 'GOAL', minute: 10, homeScore: 1, awayScore: 0 }),
      row({ eventType: 'GOAL', minute: 20, playerName: 'Ghost', homeScore: 1, awayScore: 0 }),
    ];
    expect(deriveFullTimeScorers(rows)).toEqual([]);
  });

  it('returns an empty list for a scoreless draw', () => {
    expect(deriveFullTimeScorers([])).toEqual([]);
  });
});
