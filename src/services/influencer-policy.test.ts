import { describe, expect, it } from 'vitest';
import type { GeneratedInfluencerContent } from '../domain/content.js';
import { validateInfluencerContent } from './influencer-policy.js';

function content(
  overrides: Partial<GeneratedInfluencerContent> = {},
): GeneratedInfluencerContent {
  return {
    postText:
      'THAT BACK LINE.\n\nChelsea 0–3 Arsenal. Full time.\n\nThis is the worst defence in Premier League history.\n\nThey looked lost for 90 minutes.',
    referencedFacts: ['Chelsea 0–3 Arsenal'],
    opinionClaims: ['This is the worst defence in Premier League history.'],
    risk: 'low',
    ...overrides,
  };
}

describe('validateInfluencerContent', () => {
  it('allows a career-wide conclusion listed as an opinion', () => {
    expect(
      validateInfluencerContent(content(), ['Chelsea 0–3 Arsenal', 'Chelsea', 'Arsenal'], []),
    ).toEqual({ valid: true });
  });

  it('rejects missing opinion claims', () => {
    const result = validateInfluencerContent(
      content({ opinionClaims: [] }),
      ['Chelsea 0–3 Arsenal'],
      [],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(error => error.includes('opinion claim'))).toBe(true);
    }
  });

  it('rejects an unapproved factual claim', () => {
    const result = validateInfluencerContent(
      content({ referencedFacts: ['Haaland has 40 league goals'] }),
      ['Chelsea 0–3 Arsenal'],
      [],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(error => error.includes('unapproved fact'))).toBe(true);
    }
  });
});
