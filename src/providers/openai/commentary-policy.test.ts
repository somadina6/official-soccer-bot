import { describe, expect, it } from 'vitest';
import { commentaryPolicy } from './commentary.js';
import { MATCHMOUTH_IDENTITY } from './identity.js';

describe('commentaryPolicy identity', () => {
  it('opens with the MatchMouth identity', () => {
    const policy = commentaryPolicy('playful', 'punchy', 'goal');
    expect(policy.startsWith(MATCHMOUTH_IDENTITY)).toBe(true);
    expect(policy).toContain('Target tone: playful.');
    expect(policy).toContain('football personality');
    expect(policy).not.toContain('tone ceiling');
  });
});
