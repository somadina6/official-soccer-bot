import { describe, expect, it } from 'vitest';
import type { GeneratedContent } from '../domain/content.js';
import type { MatchEvent } from '../domain/match-event.js';
import { similarity, validateContent } from './content-policy.js';

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

const validContent: GeneratedContent = {
  postText: "ARSENAL HAVE FOUND THE DOOR. Saka, 67'. Arsenal 2–1 Chelsea. North London is making noise.",
  imagePrompt: 'Abstract editorial football illustration in red and blue.',
  altText: 'AI-generated editorial football illustration. Overlay: Saka goal, 67th minute, Arsenal 2–1 Chelsea.',
  referencedFacts: ['Saka', "67'", 'Arsenal 2–1 Chelsea'],
  risk: 'low',
};

describe('validateContent', () => {
  it('accepts a factually accurate post', () => {
    expect(validateContent(validContent, goalEvent, [])).toEqual({ valid: true });
  });

  it('rejects text over 240 characters', () => {
    const result = validateContent(
      { ...validContent, postText: validContent.postText + ' x'.repeat(120) },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a missing player name', () => {
    const result = validateContent(
      { ...validContent, postText: "GOAL, 67'. Arsenal 2–1 Chelsea." },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join()).toContain('Saka');
  });

  it('rejects a transposed score', () => {
    const result = validateContent(
      { ...validContent, postText: "Saka, 67'. Arsenal 1–2 Chelsea." },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
  });

  it('rejects invented numbers', () => {
    const result = validateContent(
      { ...validContent, postText: "Saka, 67'. Arsenal 2–1 Chelsea. His 15th goal!" },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
  });

  it('allows qualitative incident facts from the approved context', () => {
    const result = validateContent(
      {
        ...validContent,
        postText: "Saka, 67'. Arsenal 2–1 Chelsea. Left foot, low left, from open play.",
      },
      goalEvent,
      [],
      ['from open play', 'left foot', 'low left', 'player is a defender'],
    );
    expect(result).toEqual({ valid: true });
  });

  it('rejects URLs', () => {
    const result = validateContent(
      { ...validContent, postText: validContent.postText.replace('noise.', 'noise. https://x.com') },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
  });

  it('rejects unsupported superlatives', () => {
    const result = validateContent(
      { ...validContent, postText: "Record-breaking! Saka, 67'. Arsenal 2–1 Chelsea." },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
  });

  it('rejects betting language', () => {
    const result = validateContent(
      { ...validContent, postText: "Saka, 67'. Arsenal 2–1 Chelsea. The odds were right." },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
  });

  it('rejects near-duplicates of recent posts', () => {
    const result = validateContent(validContent, goalEvent, [validContent.postText]);
    expect(result.valid).toBe(false);
  });

  it('requires AI disclosure in alt text', () => {
    const result = validateContent(
      { ...validContent, altText: 'A football illustration.' },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
  });
});

describe('similarity', () => {
  it('scores identical strings as 1', () => {
    expect(similarity('Saka scores again', 'Saka scores again')).toBe(1);
  });

  it('scores unrelated strings near 0', () => {
    expect(similarity('Saka scores for Arsenal', 'Full time at Anfield today')).toBeLessThan(0.2);
  });
});
