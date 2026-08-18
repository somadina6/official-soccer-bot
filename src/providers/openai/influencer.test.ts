import { describe, expect, it } from 'vitest';
import { MATCHMOUTH_IDENTITY } from './identity.js';
import { influencerPolicy } from './influencer.js';

describe('influencerPolicy', () => {
  it('uses MatchMouth identity and allows career-wide opinions', () => {
    const policy = influencerPolicy({
      intent: 'post_match_verdict',
      tone: 'spicy',
      style: 'timeline',
      approvedFacts: ['Arsenal 2–1 Chelsea'],
      recentOpenings: [],
      match: {
        fixtureId: '1',
        home: { name: 'Arsenal', score: 2 },
        away: { name: 'Chelsea', score: 1 },
        events: ['Arsenal 2–1 Chelsea'],
      },
    });
    expect(policy.startsWith(MATCHMOUTH_IDENTITY)).toBe(true);
    expect(policy).toContain('Career-wide conclusions are allowed as opinions');
    expect(policy).toContain('Content intent: post_match_verdict.');
    expect(policy).toContain('exactly two distinct candidates');
  });
});
