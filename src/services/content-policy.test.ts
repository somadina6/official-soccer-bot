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

  it('rejects hashtags', () => {
    const result = validateContent(
      { ...validContent, postText: validContent.postText.replace('noise.', 'noise. #Arsenal') },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join()).toMatch(/hashtag/i);
  });

  it('rejects @mentions', () => {
    const result = validateContent(
      { ...validContent, postText: validContent.postText.replace('Saka', '@Saka') },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join()).toMatch(/mention/i);
  });

  it('rejects banned commentary clichés', () => {
    const result = validateContent(
      { ...validContent, postText: "What a moment! Saka, 67'. Arsenal 2–1 Chelsea." },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join()).toMatch(/cliché|cliche/i);
  });

  it('rejects more than one ALL-CAPS line', () => {
    const result = validateContent(
      {
        ...validContent,
        postText: "NO BACKLIFT.\nSAKA FINISHES IT.\nSaka, 67'. Arsenal 2–1 Chelsea.",
      },
      goalEvent,
      [],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join()).toMatch(/capitalized hook/i);
  });

  it('rejects two emojis unless the style is dramatic', () => {
    const postText = "NO BACKLIFT. ⚡🥶\nSaka, 67'. Arsenal 2–1 Chelsea.\nThe net found out last.";
    const punchy = validateContent({ ...validContent, postText }, goalEvent, [], [], { style: 'punchy' });
    expect(punchy.valid).toBe(false);
    const dramatic = validateContent({ ...validContent, postText }, goalEvent, [], [], {
      style: 'dramatic',
    });
    expect(dramatic).toEqual({ valid: true });
  });

  it('allows a red card post that names the team but not the player', () => {
    const redEvent: MatchEvent = {
      ...goalEvent,
      type: 'RED_CARD',
      minute: 61,
      player: { id: '8', name: 'Rice' },
      home: { id: '1', name: 'Arsenal', score: 1, colours: ['#EF0107'] },
      away: { id: '2', name: 'Chelsea', score: 0, colours: ['#034694'] },
    };
    const result = validateContent(
      {
        ...validContent,
        postText: "EARLY SHOWER.\nArsenal are down to ten after 61 minutes.\nArsenal 1–0 Chelsea.\nThe tactical plan has just been fed into the shredder.",
      },
      redEvent,
      [],
      [],
      { situation: 'red_card' },
    );
    expect(result).toEqual({ valid: true });
  });

  it('allows a penalty save that names the keeper instead of the taker', () => {
    const savedEvent: MatchEvent = {
      ...goalEvent,
      type: 'PENALTY_MISSED',
      minute: 78,
      player: { id: '9', name: 'Haaland' },
      home: { id: '1', name: 'Everton', score: 1, colours: [] },
      away: { id: '2', name: 'Arsenal', score: 0, colours: [] },
    };
    const result = validateContent(
      {
        ...validContent,
        postText: "NOT TODAY.\nPickford saves the 78' penalty. Everton 1–0 Arsenal.\nRead it like tomorrow's newspaper.",
      },
      savedEvent,
      [],
      ['penalty saved', 'goalkeeper Pickford'],
      { situation: 'penalty_saved' },
    );
    expect(result).toEqual({ valid: true });
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
