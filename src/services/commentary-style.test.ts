import { describe, expect, it } from 'vitest';
import { sampleCommentaryStyle, styleWeights } from './commentary-style.js';

describe('styleWeights', () => {
  it('uses the playful mix at full time including timeline', () => {
    expect(styleWeights('full_time', 'playful')).toEqual([
      { style: 'punchy', weight: 30 },
      { style: 'playful', weight: 25 },
      { style: 'dramatic', weight: 15 },
      { style: 'timeline', weight: 20 },
      { style: 'question', weight: 10 },
    ]);
  });

  it('drops question except at full time', () => {
    const styles = styleWeights('goal', 'playful').map(entry => entry.style);
    expect(styles).toEqual(['punchy', 'playful', 'dramatic', 'timeline']);
  });

  it('drops playful and timeline for a neutral tone', () => {
    expect(styleWeights('goal', 'neutral')).toEqual([
      { style: 'punchy', weight: 70 },
      { style: 'dramatic', weight: 30 },
    ]);
    expect(styleWeights('full_time', 'neutral')).toEqual([
      { style: 'punchy', weight: 60 },
      { style: 'dramatic', weight: 25 },
      { style: 'question', weight: 15 },
    ]);
  });

  it('makes timeline the dominant spicy style', () => {
    expect(styleWeights('goal', 'spicy')).toEqual([
      { style: 'punchy', weight: 30 },
      { style: 'playful', weight: 20 },
      { style: 'dramatic', weight: 10 },
      { style: 'timeline', weight: 40 },
    ]);
    expect(styleWeights('full_time', 'spicy')).toEqual([
      { style: 'punchy', weight: 25 },
      { style: 'playful', weight: 20 },
      { style: 'dramatic', weight: 10 },
      { style: 'timeline', weight: 35 },
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

  it('never samples playful or timeline when tone is neutral', () => {
    for (let i = 0; i < 100; i++) {
      const style = sampleCommentaryStyle('full_time', 'neutral', () => i / 100);
      expect(style).not.toBe('playful');
      expect(style).not.toBe('timeline');
    }
  });

  it('can sample question at full time', () => {
    expect(sampleCommentaryStyle('full_time', 'playful', () => 0.99)).toBe('question');
  });
});
