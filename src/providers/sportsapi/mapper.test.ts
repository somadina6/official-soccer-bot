import { describe, expect, it } from 'vitest';
import { buildIdempotencyKey } from '../../domain/match-event.js';
import {
  extractScheduledMatches,
  normalizeIncident,
  type MatchContext,
} from './mapper.js';

const context: MatchContext = {
  matchId: '14109842',
  competitionId: '1',
  home: { id: '1', name: 'Arsenal', score: 1, colours: ['#EF0107'] },
  away: { id: '2', name: 'Chelsea', score: 1, colours: ['#034694'] },
};

describe('normalizeIncident', () => {
  it('normalizes a confirmed goal with score update', () => {
    const event = normalizeIncident(
      {
        id: 555,
        type: 'goal',
        minute: 67,
        isConfirmed: true,
        player: { id: 10, name: 'Saka' },
        homeScore: 2,
        awayScore: 1,
      },
      context,
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('GOAL');
    expect(event!.status).toBe('CONFIRMED');
    expect(event!.home.score).toBe(2);
    expect(event!.player?.name).toBe('Saka');
    expect(event!.incidentId).toBe('555');
  });

  it('marks cancelled incidents as OVERTURNED', () => {
    const event = normalizeIncident(
      { id: 555, type: 'goal', minute: 67, isCancelled: true },
      context,
    );
    expect(event!.status).toBe('OVERTURNED');
  });

  it('ignores yellow cards and substitutions', () => {
    expect(normalizeIncident({ id: 1, type: 'yellow_card', minute: 30 }, context)).toBeNull();
    expect(normalizeIncident({ id: 2, type: 'substitution', minute: 60 }, context)).toBeNull();
  });

  it('produces a stable hash for identical payloads', () => {
    const payload = { id: 555, type: 'goal', minute: 67 };
    const a = normalizeIncident(payload, context);
    const b = normalizeIncident({ ...payload }, context);
    expect(a!.rawPayloadHash).toBe(b!.rawPayloadHash);
  });
});

describe('buildIdempotencyKey', () => {
  it('uses the provider incident ID when available', () => {
    const event = normalizeIncident({ id: 555, type: 'goal', minute: 67 }, context)!;
    expect(buildIdempotencyKey(event, 0)).toBe('sportsapi-pro:14109842:555:0');
  });

  it('falls back to minute/type/player when there is no incident ID', () => {
    const event = normalizeIncident(
      { type: 'red_card', minute: 88, player: { id: 4, name: 'Someone' } },
      context,
    )!;
    expect(buildIdempotencyKey(event, 1)).toBe('sportsapi-pro:14109842:88:RED_CARD:4:1');
  });
});

describe('extractScheduledMatches', () => {
  it('extracts matches grouped by tournament and skips malformed rows', () => {
    const payload = {
      data: {
        tournaments: [
          {
            matches: [
              {
                id: 14109842,
                startTimestamp: 1765800000,
                tournament: { id: 17 },
                homeTeam: { name: 'Arsenal' },
                awayTeam: { name: 'Chelsea' },
              },
              { bogus: true },
            ],
          },
        ],
      },
    };
    const matches = extractScheduledMatches(payload);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe(14109842);
  });

  it('returns an empty list for unrecognized payloads', () => {
    expect(extractScheduledMatches({ unexpected: true })).toEqual([]);
    expect(extractScheduledMatches(null)).toEqual([]);
  });
});
