import { describe, expect, it } from 'vitest';
import type { CommentaryModelOutput } from '../domain/content.js';
import type { MatchEvent } from '../domain/match-event.js';
import { rankCandidates } from './commentary-ranker.js';

const goalEvent: MatchEvent = {
  provider: 'sportsapi-pro',
  matchId: '14109842',
  incidentId: 'inc-1',
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

const artwork = {
  altText: 'Editorial football illustration. Overlay: Saka goal, 67th minute, Arsenal 2–1 Chelsea.',
  referencedFacts: ['Saka', "67'", 'Arsenal 2–1 Chelsea'],
  risk: 'low' as const,
};

describe('rankCandidates', () => {
  it('drops invalid candidates and prefers specific 100–220 copy', () => {
    const output: CommentaryModelOutput = {
      ...artwork,
      candidates: [
        {
          hook: 'GOOOOAL',
          factLine: "Saka, 67'. Arsenal 2–1 Chelsea.",
          punchline: 'Get in.',
        },
        {
          hook: 'NO BACKLIFT. NO WARNING.',
          factLine: "Saka, 67'. Arsenal 2–1 Chelsea.",
          punchline: 'Left foot, low left, and the net found out last.',
        },
      ],
    };

    const { winner, ranked } = rankCandidates(
      output,
      goalEvent,
      [],
      ['left foot', 'low left', 'from open play'],
      'punchy',
      'goal',
    );

    expect(ranked[0]?.valid).toBe(false);
    expect(ranked[1]?.valid).toBe(true);
    expect(winner?.postText).toContain('NO BACKLIFT');
    expect(winner?.postText).toContain('Left foot');
    expect(winner?.candidates).toHaveLength(2);
  });

  it('returns no winner when every candidate fails validation', () => {
    const output: CommentaryModelOutput = {
      ...artwork,
      candidates: [
        { hook: 'GOAL', factLine: 'Wrong score.', punchline: 'Nope.' },
        { hook: 'GOAL', factLine: 'Still wrong.', punchline: 'Nope.' },
      ],
    };
    const { winner, ranked } = rankCandidates(output, goalEvent, [], [], 'punchy', 'goal');
    expect(winner).toBeUndefined();
    expect(ranked.every(row => !row.valid)).toBe(true);
  });
});
