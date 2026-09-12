import { describe, expect, it } from 'vitest';
import { sampleCommentaryStyle, sampleInfluencerStyle, styleWeights } from './commentary-style.js';

describe('styleWeights', () => {
  it('only offers punchy and timeline for neutral tone', () => {
    expect(styleWeights('goal', 'neutral')).toEqual([
      { style: 'punchy', weight: 60 },
      { style: 'timeline', weight: 40 },
    ]);
    expect(styleWeights('full_time', 'neutral')).toEqual([
      { style: 'punchy', weight: 60 },
      { style: 'timeline', weight: 40 },
    ]);
  });

  it('only offers punchy and timeline for playful tone', () => {
    expect(styleWeights('goal', 'playful')).toEqual([
      { style: 'punchy', weight: 50 },
      { style: 'timeline', weight: 50 },
    ]);
  });

  it('makes timeline the dominant spicy style', () => {
    expect(styleWeights('goal', 'spicy')).toEqual([
      { style: 'punchy', weight: 40 },
      { style: 'timeline', weight: 60 },
    ]);
  });
});

describe('sampleCommentaryStyle', () => {
  it('only ever samples punchy or timeline', () => {
    for (let i = 0; i < 100; i++) {
      const style = sampleCommentaryStyle('goal', 'spicy', () => i / 100);
      expect(['punchy', 'timeline']).toContain(style);
    }
  });

  it('can sample punchy or timeline at full time too', () => {
    for (let i = 0; i < 100; i++) {
      const style = sampleCommentaryStyle('full_time', 'neutral', () => i / 100);
      expect(['punchy', 'timeline']).toContain(style);
    }
  });
});

describe('sampleInfluencerStyle', () => {
  it('only ever samples punchy or timeline for a post-match verdict', () => {
    for (let i = 0; i < 100; i++) {
      const style = sampleInfluencerStyle('post_match_verdict', 'playful', () => i / 100);
      expect(['punchy', 'timeline']).toContain(style);
    }
  });

  it('only ever samples punchy or timeline for a prediction', () => {
    for (let i = 0; i < 100; i++) {
      const style = sampleInfluencerStyle('prediction', 'spicy', () => i / 100);
      expect(['punchy', 'timeline']).toContain(style);
    }
  });

  it('reuses a persisted style instead of resampling', () => {
    const persisted = 'timeline' as const;
    const sampled = sampleInfluencerStyle('prediction', 'neutral', () => 0);
    expect(persisted ?? sampled).toBe('timeline');
    expect(sampled).toBe('punchy');
  });
});
