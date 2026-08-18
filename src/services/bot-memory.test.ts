import { describe, expect, it } from 'vitest';
import { establishedTakes, shouldSkipReceipt } from './bot-memory.js';
import { resultOutcome } from './influencer-context.js';

describe('shouldSkipReceipt', () => {
  it('skips when no stored prediction exists', () => {
    expect(shouldSkipReceipt(null)).toBe(true);
    expect(
      shouldSkipReceipt({
        id: '1',
        fixtureId: '9',
        prediction: 'I backed Newcastle.',
      }),
    ).toBe(false);
  });
});

describe('establishedTakes', () => {
  it('formats prior opinions for the prompt', () => {
    expect(
      establishedTakes([
        {
          id: '1',
          subject_type: 'team',
          subject_name: 'Newcastle',
          stance: 'I backed them before kickoff.',
          evidence: [],
          status: 'active',
        },
      ]),
    ).toEqual(['Newcastle: I backed them before kickoff.']);
  });
});

describe('resultOutcome', () => {
  const result = {
    home: { name: 'Newcastle', score: 2 },
    away: { name: 'Fulham', score: 0 },
    winner: 'Newcastle',
  };

  it('marks a stored prediction correct or incorrect from the verified result', () => {
    expect(resultOutcome('I backed Newcastle before kickoff.', result)).toBe('correct');
    expect(resultOutcome('Fulham to nick this.', result)).toBe('incorrect');
    expect(resultOutcome('This will be chaotic.', result)).toBe('unresolved');
  });
});
