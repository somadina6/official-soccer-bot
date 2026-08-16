import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { MatchEvent } from '../domain/match-event.js';
import { ImageFlowError } from '../image-flow/errors.js';
import { logger } from '../observability/logger.js';

/** GPT Image 2 landscape canvas (plan section 2). */
export const IMAGE_WIDTH = 1536;
export const IMAGE_HEIGHT = 1024;

const EVENT_LABELS: Record<MatchEvent['type'], string> = {
  GOAL: 'GOAL',
  OWN_GOAL: 'OWN GOAL',
  RED_CARD: 'RED CARD',
  PENALTY_MISSED: 'PENALTY MISSED',
  VAR: 'VAR DECISION',
  FULL_TIME: 'FULL TIME',
};

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Truncate on a word boundary when possible so long names stay inside the safe margin. */
export function truncateLabel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  const broken = sliced.replace(/\s+\S*$/, '');
  const base = broken.length >= Math.floor(maxChars / 2) ? broken : sliced;
  return `${base}…`;
}

/**
 * Deterministic score-card overlay (plan section 10): the image model paints
 * the scene, but every factual element — event label, player, minute, score,
 * team names — is rendered by code so it is always exactly right.
 */
function overlaySvg(event: MatchEvent): string {
  const label = EVENT_LABELS[event.type];
  const minute = event.stoppageMinute
    ? `${event.minute}+${event.stoppageMinute}'`
    : `${event.minute}'`;
  const player = event.player ? escapeXml(truncateLabel(event.player.name, 42)) : '';
  const home = escapeXml(truncateLabel(event.home.name, 22));
  const away = escapeXml(truncateLabel(event.away.name, 22));
  const scoreline = `${home}  ${event.home.score} \u2013 ${event.away.score}  ${away}`;
  const detailLine = [player, event.type === 'FULL_TIME' ? '' : minute]
    .filter(Boolean)
    .join('  \u00b7  ');

  const fadeTop = IMAGE_HEIGHT - 320;
  return `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.88"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${fadeTop}" width="${IMAGE_WIDTH}" height="320" fill="url(#fade)"/>
  <text x="72" y="${IMAGE_HEIGHT - 216}" font-family="Arial Black, Helvetica, sans-serif" font-size="64"
        font-weight="900" fill="#ffffff" letter-spacing="2">${label}</text>
  ${detailLine ? `<text x="72" y="${IMAGE_HEIGHT - 140}" font-family="Arial, Helvetica, sans-serif" font-size="44"
        font-weight="700" fill="#ffffff">${detailLine}</text>` : ''}
  <text x="72" y="${IMAGE_HEIGHT - 64}" font-family="Arial, Helvetica, sans-serif" font-size="38"
        font-weight="600" fill="#e8e8e8">${scoreline}</text>
</svg>`;
}

/** Composes the final 1536×1024 JPEG from generated (or fallback) artwork plus the overlay. */
export async function composeEventImage(background: Buffer, event: MatchEvent): Promise<Buffer> {
  try {
    const image = await sharp(background)
      .rotate()
      .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: 'attention' })
      .composite([{ input: Buffer.from(overlaySvg(event)), top: 0, left: 0 }])
      .jpeg({ quality: 85, progressive: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    await maybeWriteLocalPreview(image, event);
    return image;
  } catch (error) {
    throw new ImageFlowError(
      'IMAGE_COMPOSITE_FAILED',
      error instanceof Error ? error.message : 'composite failed',
    );
  }
}

/** Writes the composed image to tmp/composed so you can open it locally. */
async function maybeWriteLocalPreview(image: Buffer, event: MatchEvent): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'production') return;
  const dir = join(process.cwd(), 'tmp', 'composed');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${event.matchId}-${event.type}-${event.minute}.jpg`;
  const path = join(dir, name);
  await writeFile(path, image);
  logger.info({ path }, 'wrote composed image preview');
}

/** Neutral fallback base when generation times out or is blocked. */
export async function solidFallbackBackground(colours: string[]): Promise<Buffer> {
  const primary = colours[0] ?? '#12233d';
  const secondary = colours[1] ?? '#0b1524';
  const svg = `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="30%" r="80%">
      <stop offset="0%" stop-color="${escapeXml(primary)}"/>
      <stop offset="100%" stop-color="${escapeXml(secondary)}"/>
    </radialGradient>
  </defs>
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#glow)"/>
</svg>`;
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 85, progressive: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
