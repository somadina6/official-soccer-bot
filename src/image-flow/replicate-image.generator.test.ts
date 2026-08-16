import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ImageFlowError } from './errors.js';
import { generateReplicateArtwork, type ReplicateRun } from './replicate-image.generator.js';

const env = {
  IMAGE_GENERATION_DEADLINE_MS: 30_000,
  IMAGE_OUTPUT_COMPRESSION: 85,
  REPLICATE_IMAGE_MODEL: 'xai/grok-imagine-image',
  REPLICATE_IMAGE_ASPECT_RATIO: '3:2',
};

async function jpegBytes(): Promise<Buffer> {
  const noise = Buffer.alloc(120 * 80 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 13) % 256;
  return sharp(noise, { raw: { width: 120, height: 80, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 40, b: 80 } },
  })
    .png()
    .toBuffer();
}

describe('generateReplicateArtwork', () => {
  it('downloads a string JPEG URL (dashboard shape)', async () => {
    const jpeg = await jpegBytes();
    const run: ReplicateRun = async (model, options) => {
      expect(model).toBe('xai/grok-imagine-image');
      expect(options.input).toEqual({
        prompt: 'a goal celebration',
        aspect_ratio: '3:2',
      });
      return 'https://replicate.delivery/xezq/example/tmp_2do7pdn.jpg';
    };
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe('https://replicate.delivery/xezq/example/tmp_2do7pdn.jpg');
      return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    const result = await generateReplicateArtwork('a goal celebration', { run, fetchImpl, env });
    expect(result.attempts).toBe(1);
    const meta = await sharp(result.image).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('reads a FileOutput blob', async () => {
    const jpeg = await jpegBytes();
    const run: ReplicateRun = async () => ({
      blob: async () => new Blob([jpeg], { type: 'image/jpeg' }),
    });

    const result = await generateReplicateArtwork('prompt', { run, env });
    expect((await sharp(result.image).metadata()).format).toBe('jpeg');
  });

  it('takes the first element of an array output', async () => {
    const jpeg = await jpegBytes();
    const run: ReplicateRun = async () => ['https://replicate.delivery/out.jpg'];
    const fetchImpl: typeof fetch = async () =>
      new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });

    const result = await generateReplicateArtwork('prompt', { run, fetchImpl, env });
    expect((await sharp(result.image).metadata()).format).toBe('jpeg');
  });

  it('converts PNG bytes to JPEG', async () => {
    const png = await pngBytes();
    const run: ReplicateRun = async () => ({
      blob: async () => new Blob([png], { type: 'image/png' }),
    });

    const result = await generateReplicateArtwork('prompt', { run, env });
    expect((await sharp(result.image).metadata()).format).toBe('jpeg');
  });

  it('omits resolution unless configured', async () => {
    const jpeg = await jpegBytes();
    let seenInput: Record<string, unknown> | undefined;
    const run: ReplicateRun = async (_model, options) => {
      seenInput = options.input;
      return { blob: async () => new Blob([jpeg], { type: 'image/jpeg' }) };
    };

    await generateReplicateArtwork('prompt', {
      run,
      env: { ...env, REPLICATE_IMAGE_RESOLUTION: '1k' },
    });
    expect(seenInput).toMatchObject({ resolution: '1k', aspect_ratio: '3:2' });
  });

  it('retries once on 429 then succeeds', async () => {
    const jpeg = await jpegBytes();
    let calls = 0;
    const run: ReplicateRun = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('rate limited') as Error & { response: { status: number } };
        error.name = 'ApiError';
        error.response = { status: 429 };
        throw error;
      }
      return { blob: async () => new Blob([jpeg], { type: 'image/jpeg' }) };
    };

    const result = await generateReplicateArtwork('prompt', { run, env });
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
  });

  it('maps abort to IMAGE_GENERATION_TIMEOUT', async () => {
    const run: ReplicateRun = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };
    await expect(generateReplicateArtwork('prompt', { run, env })).rejects.toMatchObject({
      code: 'IMAGE_GENERATION_TIMEOUT',
    } satisfies Partial<ImageFlowError>);
  });

  it('maps moderation errors', async () => {
    const run: ReplicateRun = async () => {
      throw new Error('NSFW content flagged by safety checker');
    };
    await expect(generateReplicateArtwork('prompt', { run, env })).rejects.toMatchObject({
      code: 'IMAGE_GENERATION_MODERATION_BLOCKED',
    });
  });
});
