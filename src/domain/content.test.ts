import { describe, expect, it } from 'vitest';
import {
  InfluencerPostOutputSchema,
  composeInfluencerPostText,
} from './content.js';

describe('InfluencerPostOutputSchema', () => {
  const candidate = {
    hook: 'THAT WAS AFT.',
    factLine: 'Arsenal 2–1 Chelsea. Full time.',
    opinion: 'This is the worst Chelsea defence in Premier League history.',
    punchline: 'They spent 90 minutes proving it.',
  };

  it('accepts exactly two candidates', () => {
    const parsed = InfluencerPostOutputSchema.parse({
      candidates: [candidate, { ...candidate, hook: 'DIFFERENT HOOK' }],
      referencedFacts: ['Arsenal 2–1 Chelsea'],
      opinionClaims: ['worst Chelsea defence in Premier League history'],
      risk: 'low',
    });
    expect(parsed.candidates).toHaveLength(2);
  });

  it('rejects three candidates', () => {
    const result = InfluencerPostOutputSchema.safeParse({
      candidates: [candidate, candidate, candidate],
      referencedFacts: [],
      opinionClaims: ['take'],
      risk: 'low',
    });
    expect(result.success).toBe(false);
  });
});

describe('composeInfluencerPostText', () => {
  it('joins the four lines', () => {
    expect(
      composeInfluencerPostText({
        hook: 'HOOK',
        factLine: 'FACT',
        opinion: 'OPINION',
        punchline: 'PUNCH',
      }),
    ).toBe('HOOK\n\nFACT\n\nOPINION\n\nPUNCH');
  });
});
