import { describe, expect, it } from 'vitest';
import { rankInfluencerCandidates } from './influencer-ranker.js';

describe('rankInfluencerCandidates', () => {
  it('picks a valid winner from two candidates', () => {
    const { winner, ranked } = rankInfluencerCandidates(
      {
        candidates: [
          {
            hook: 'GAME OVER.',
            factLine: 'Arsenal 2–1 Chelsea. Full time.',
            opinion: 'Chelsea were second best everywhere.',
            punchline: 'The gap looked huge tonight.',
          },
          {
            hook: 'SAME OLD STORY.',
            factLine: 'Arsenal 2–1 Chelsea. Full time.',
            opinion: 'This is the worst Chelsea defence in Premier League history.',
            punchline: 'They never looked like a team.',
          },
        ],
        referencedFacts: ['Arsenal 2–1 Chelsea'],
        opinionClaims: ['Chelsea were second best everywhere.'],
        risk: 'low',
      },
      ['Arsenal 2–1 Chelsea', 'Arsenal', 'Chelsea'],
      [],
      'punchy',
    );
    expect(ranked).toHaveLength(2);
    expect(winner?.postText).toContain('Arsenal 2–1 Chelsea');
    expect(winner?.opinionClaims.length).toBeGreaterThan(0);
  });
});
