import { describe, expect, it } from 'vitest';
import { sampleCommentaryStyle, styleWeights } from './commentary-style.js';

describe('styleWeights', () => {
  it('uses the launch mix at full time with a playful tone', () => {
    expect(styleWeights('full_time', 'playful')).toEqual([
      { style: 'punchy', weight: 40 },
      { style: 'playful', weight: 30 },
      { style: 'dramatic', weight: 20 },
      { style: 'question', weight: 10 },
    ]);
  });

  it('drops question except at full time', () => {
    const styles = styleWeights('goal', 'playful').map(entry => entry.style);
    expect(styles).toEqual(['punchy', 'playful', 'dramatic']);
  });

  it('drops playful banter for a neutral tone and redistributes to punchy and dramatic', () => {
    expect(styleWeights('goal', 'neutral')).toEqual([
      { style: 'punchy', weight: 60 },
      { style: 'dramatic', weight: 30 },
    ]);
    expect(styleWeights('full_time', 'neutral')).toEqual([
      { style: 'punchy', weight: 60 },
      { style: 'dramatic', weight: 30 },
      { style: 'question', weight: 10 },
    ]);
  });
});

describe('sampleCommentaryStyle', () => {
  it('never samples question except at full time', () => {
    for (let i = 0; i < 100; i++) {
      expect(sampleCommentaryStyle('goal', 'playful', () => i / 100)).not.toBe('question');
    }
  });

  it('never samples playful when tone is neutral', () => {
    for (let i = 0; i < 100; i++) {
      expect(sampleCommentaryStyle('full_time', 'neutral', () => i / 100)).not.toBe('playful');
    }
  });

  it('can sample question at full time', () => {
    expect(sampleCommentaryStyle('full_time', 'playful', () => 0.99)).toBe('question');
  });
});
