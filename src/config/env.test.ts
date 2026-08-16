import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const required = {
  SPORTSAPI_KEY: 'sports-key',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  SUPABASE_DB_URL: 'postgresql://postgres:pass@localhost:5432/postgres',
  SUPABASE_STORAGE_BUCKET: 'generated-match-media',
  OPENAI_API_KEY: 'sk-test',
  TWITTER_CONSUMER_KEY: 'ck',
  TWITTER_CONSUMER_SECRET: 'cs',
  TWITTER_ACCESS_TOKEN: 'at',
  TWITTER_ACCESS_SECRET: 'as',
};

describe('parseEnv image provider', () => {
  it('defaults IMAGE_PROVIDER to openai and does not require a Replicate token', () => {
    const env = parseEnv(required);
    expect(env.IMAGE_PROVIDER).toBe('openai');
    expect(env.REPLICATE_API_TOKEN).toBeUndefined();
    expect(env.REPLICATE_IMAGE_MODEL).toBe('xai/grok-imagine-image');
    expect(env.REPLICATE_IMAGE_ASPECT_RATIO).toBe('3:2');
    expect(env.REPLICATE_IMAGE_RESOLUTION).toBeUndefined();
  });

  it('accepts replicate when REPLICATE_API_TOKEN is set', () => {
    const env = parseEnv({
      ...required,
      IMAGE_PROVIDER: 'replicate',
      REPLICATE_API_TOKEN: 'r8_test',
    });
    expect(env.IMAGE_PROVIDER).toBe('replicate');
    expect(env.REPLICATE_API_TOKEN).toBe('r8_test');
  });

  it('rejects replicate without REPLICATE_API_TOKEN', () => {
    expect(() =>
      parseEnv({
        ...required,
        IMAGE_PROVIDER: 'replicate',
      }),
    ).toThrow(/REPLICATE_API_TOKEN/);
  });

  it('treats an empty Replicate token as missing', () => {
    expect(() =>
      parseEnv({
        ...required,
        IMAGE_PROVIDER: 'replicate',
        REPLICATE_API_TOKEN: '',
      }),
    ).toThrow(/REPLICATE_API_TOKEN/);
  });

  it('omits resolution unless set', () => {
    const withRes = parseEnv({
      ...required,
      REPLICATE_IMAGE_RESOLUTION: '2k',
    });
    expect(withRes.REPLICATE_IMAGE_RESOLUTION).toBe('2k');

    const blank = parseEnv({
      ...required,
      REPLICATE_IMAGE_RESOLUTION: '',
    });
    expect(blank.REPLICATE_IMAGE_RESOLUTION).toBeUndefined();
  });
});
