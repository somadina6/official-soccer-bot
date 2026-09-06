import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { INTER_BOLD_WOFF2_BASE64 } from '../assets/fonts/inter-bold-woff2-base64.js';
import type { MatchEvent } from '../domain/match-event.js';
import { ImageFlowError } from '../image-flow/errors.js';
import { logger } from '../observability/logger.js';

/** GPT Image 2 portrait canvas. */
export const IMAGE_WIDTH = 1024;
export const IMAGE_HEIGHT = 1536;

const OVERLAY_FONT_FAMILY = 'MatchMouthOverlay';

/**
 * Embeds the overlay font directly in the SVG as base64, instead of
 * referencing a system font by name (e.g. "Arial"). The container this runs
 * in (Railway) has no fonts installed, which made every code-drawn overlay
 * text — the full-time scorers list, and previously the scoreboard/caption
 * overlay — render as blank tofu boxes in production even though it looked
 * fine on a dev machine that happens to have system fonts.
 */
const OVERLAY_FONT_FACE_SVG = `
  <defs>
    <style>
      @font-face {
        font-family: '${OVERLAY_FONT_FAMILY}';
        src: url(data:font/woff2;base64,${INTER_BOLD_WOFF2_BASE64}) format('woff2');
        font-weight: 700;
      }
    </style>
  </defs>
`;

const EVENT_LABELS: Record<MatchEvent['type'], string> = {
  GOAL: 'GOAL',
  OWN_GOAL: 'OWN GOAL',
  RED_CARD: 'RED CARD',
  PENALTY_MISSED: 'PENALTY MISSED',
  VAR: 'VAR DECISION',
  FULL_TIME: 'FULL-TIME',
};

const TOP_BAR_HEIGHT = 190;
const BAR_PADDING = 44;

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
 * Top scoreboard bar: home team + score on the left, away team + score on
 * the right, event label in a centered pill. Mirrors the clean broadcast
 * scoreboard look official club accounts use, with every digit rendered by
 * code so it is always exactly right.
 */
function scoreboardSvg(event: MatchEvent): string {
  const label = EVENT_LABELS[event.type];
  const home = escapeXml(truncateLabel(event.home.name, 22));
  const away = escapeXml(truncateLabel(event.away.name, 22));
  const nameY = 74;
  const scoreY = 152;
  const pillWidth = Math.max(200, label.length * 21 + 64);
  const pillHeight = 62;
  const pillX = (IMAGE_WIDTH - pillWidth) / 2;
  const pillY = (TOP_BAR_HEIGHT - pillHeight) / 2;

  return `
  <rect x="0" y="0" width="${IMAGE_WIDTH}" height="${TOP_BAR_HEIGHT}" fill="#0a1526" fill-opacity="0.93"/>
  <text x="${BAR_PADDING}" y="${nameY}" font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="24"
        font-weight="700" fill="#c9d3e0" letter-spacing="1">${home}</text>
  <text x="${BAR_PADDING}" y="${scoreY}" font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="60"
        font-weight="900" fill="#ffffff">${event.home.score}</text>
  <text x="${IMAGE_WIDTH - BAR_PADDING}" y="${nameY}" text-anchor="end"
        font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="24" font-weight="700" fill="#c9d3e0"
        letter-spacing="1">${away}</text>
  <text x="${IMAGE_WIDTH - BAR_PADDING}" y="${scoreY}" text-anchor="end"
        font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="60" font-weight="900"
        fill="#ffffff">${event.away.score}</text>
  <rect x="${pillX}" y="${pillY}" width="${pillWidth}" height="${pillHeight}" rx="31" fill="#ffffff"
        fill-opacity="0.12" stroke="#ffffff" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="${IMAGE_WIDTH / 2}" y="${pillY + pillHeight / 2 + 12}" text-anchor="middle"
        font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="30" font-weight="900" fill="#ffffff"
        letter-spacing="2">${label}</text>
`;
}

/** Bottom player caption: name and minute only, in clean white text. Skipped when no player is involved. */
function captionSvg(event: MatchEvent): string {
  if (!event.player || event.type === 'FULL_TIME') return '';
  const minute = event.stoppageMinute
    ? `${event.minute}+${event.stoppageMinute}'`
    : `${event.minute}'`;
  const player = escapeXml(truncateLabel(event.player.name, 24).toUpperCase());
  const fadeTop = IMAGE_HEIGHT - 300;

  return `
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.85"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${fadeTop}" width="${IMAGE_WIDTH}" height="300" fill="url(#fade)"/>
  <text x="${BAR_PADDING}" y="${IMAGE_HEIGHT - 128}" font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="72"
        font-weight="900" fill="#ffffff" letter-spacing="1">${player}</text>
  <text x="${BAR_PADDING}" y="${IMAGE_HEIGHT - 68}" font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="34"
        font-weight="600" fill="#e3e8ef">${minute}</text>
`;
}

/** One confirmed goal, ready to be drawn on the full-time scorers list. */
export type FullTimeScorer = {
  name: string;
  minute: number;
  stoppageMinute?: number | undefined;
  side: 'home' | 'away';
  ownGoal: boolean;
};

const SCORERS_TOP = TOP_BAR_HEIGHT + 34;
const SCORERS_ROW_HEIGHT = 34;

function scorerLabel(entry: FullTimeScorer): string {
  const minute = entry.stoppageMinute ? `${entry.minute}+${entry.stoppageMinute}'` : `${entry.minute}'`;
  const name = escapeXml(truncateLabel(entry.name, 22));
  const suffix = entry.ownGoal ? ' (OG)' : '';
  return `${minute}  ${name}${suffix}`;
}

function scorersColumnSvg(entries: readonly FullTimeScorer[], side: 'home' | 'away'): string {
  const column = entries.filter(entry => entry.side === side);
  const anchor = side === 'home' ? 'start' : 'end';
  const x = side === 'home' ? BAR_PADDING : IMAGE_WIDTH - BAR_PADDING;
  return column
    .map((entry, index) => {
      const y = SCORERS_TOP + index * SCORERS_ROW_HEIGHT;
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="26" font-weight="700" fill="#f4f6fa">${escapeXml(scorerLabel(entry))}</text>`;
    })
    .join('\n');
}

/**
 * Full-time scorers list: minute + name per side, code-rendered directly
 * beneath the model-rendered top bar so every name is spelled exactly right
 * (the AI image prompt reserves this band — see FULL_TIME_CONSTRAINTS in
 * prompt-builder.ts). Skipped entirely when there are no known scorers.
 */
function scorersSvg(entries: readonly FullTimeScorer[]): string {
  if (entries.length === 0) return '';
  const rows = Math.max(
    entries.filter(entry => entry.side === 'home').length,
    entries.filter(entry => entry.side === 'away').length,
  );
  const backdropHeight = SCORERS_TOP - TOP_BAR_HEIGHT + rows * SCORERS_ROW_HEIGHT + 16;

  return `
  <rect x="0" y="${TOP_BAR_HEIGHT}" width="${IMAGE_WIDTH}" height="${backdropHeight}" fill="#0a1526" fill-opacity="0.72"/>
  ${scorersColumnSvg(entries, 'home')}
  ${scorersColumnSvg(entries, 'away')}
`;
}

export type ComposeEventImageOptions = {
  /**
   * When false, skips the deterministic scoreboard/caption overlay: the
   * prompt now asks the image model to render the scoreboard and player
   * name itself (prompt-builder.ts), so compositing it again would draw a
   * duplicate. Used by the AI pipeline (image-pipeline.ts); left on for
   * callers with no AI photo at all, like the VAR-correction fallback
   * (post-corrections.ts), which still needs code to draw every fact.
   */
  overlay?: boolean;
  /** Full-time only: confirmed scorers to list beneath the top bar, in code-rendered text. */
  scorers?: readonly FullTimeScorer[] | undefined;
};

/** Composes the final 1024×1536 JPEG from generated (or fallback) artwork, optionally plus the overlay. */
export async function composeEventImage(
  background: Buffer,
  event: MatchEvent,
  options: ComposeEventImageOptions = {},
): Promise<Buffer> {
  const overlay = options.overlay ?? true;
  const svgFragments: string[] = [];
  if (overlay) svgFragments.push(scoreboardSvg(event), captionSvg(event));
  if (options.scorers?.length) svgFragments.push(scorersSvg(options.scorers));
  if (svgFragments.length > 0) svgFragments.unshift(OVERLAY_FONT_FACE_SVG);

  try {
    let pipeline = sharp(background)
      .rotate()
      .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: 'attention' });
    if (svgFragments.length > 0) {
      const svg = `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  ${svgFragments.join('\n')}
</svg>`;
      pipeline = pipeline.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
    }
    const image = await pipeline
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
