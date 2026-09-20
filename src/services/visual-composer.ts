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

const COMPETITION_LABEL = 'PREMIER LEAGUE';
/** Vertical centre of the crest row, about two thirds down the frame. */
const CREST_ROW_CENTER_Y = 980;
const SCORERS_ROW_HEIGHT = 36;

/** Real crest images, when available (see loadMatchCrests in services/crests.ts). */
export type FullTimeCrests = {
  home: Buffer | null;
  away: Buffer | null;
};

const CREST_BOX_SIZE = 240;
const CREST_CENTER_Y = CREST_ROW_CENTER_Y - 110;
const CREST_CENTER_OFFSET_X = 300;

/** Resizes a fetched crest to fit inside a fixed square box, preserving aspect ratio on a transparent backdrop. */
async function fitCrestToBox(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .resize(CREST_BOX_SIZE, CREST_BOX_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/**
 * Raster composite entries placing real crests in fixed left/right slots of
 * the crest row, leaving the middle third clear for the code-drawn score.
 * Real crests are always positioned deterministically, and each side is
 * composited independently — the backdrop no longer has a model-drawn
 * crest to fall back on (see loadFullTimeBackdrop), so a lone crest fetch
 * failure just leaves that one slot empty rather than losing both.
 */
async function crestCompositeLayers(
  crests: FullTimeCrests,
): Promise<sharp.OverlayOptions[]> {
  const top = Math.round(CREST_CENTER_Y - CREST_BOX_SIZE / 2);
  const homeLeft = Math.round(IMAGE_WIDTH / 2 - CREST_CENTER_OFFSET_X - CREST_BOX_SIZE / 2);
  const awayLeft = Math.round(IMAGE_WIDTH / 2 + CREST_CENTER_OFFSET_X - CREST_BOX_SIZE / 2);
  const layers: sharp.OverlayOptions[] = [];
  if (crests.home) layers.push({ input: await fitCrestToBox(crests.home), top, left: homeLeft });
  if (crests.away) layers.push({ input: await fitCrestToBox(crests.away), top, left: awayLeft });
  return layers;
}

/** "Pascal Groß" → "P. GROSS", broadcast-style — first initial plus every word after it. */
function scorerSurnameLabel(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.toUpperCase();
  const initial = parts[0]!.charAt(0).toUpperCase();
  const surname = parts.slice(1).join(' ').toUpperCase();
  return `${initial}. ${surname}`;
}

function scorerLabel(entry: FullTimeScorer): string {
  const minute = entry.stoppageMinute ? `${entry.minute}+${entry.stoppageMinute}'` : `${entry.minute}'`;
  const suffix = entry.ownGoal ? ' (OG)' : '';
  return `${minute}  |  ${scorerSurnameLabel(entry.name)}${suffix}`;
}

/**
 * A dark outline drawn behind text fill, so words stay legible no matter how
 * bright the model's backdrop art happens to be at that exact spot — a fade
 * gradient alone isn't reliable up near the crest row, where it's still
 * mostly transparent.
 */
const TEXT_SHADOW_ATTRS = 'paint-order="stroke" stroke="#000000" stroke-opacity="0.65" stroke-width="6" stroke-linejoin="round"';

/**
 * Dark fade behind the crest row, score, and scorer list, so the whole
 * bottom third reads as a coherent panel even before the per-letter outline
 * kicks in — the same role a broadcast graphic's solid panel plays, but as
 * a soft gradient since there's no hard-edged card here.
 *
 * Starts well above the crest row (not just at its edge) because the model
 * doesn't reliably obey "no text" / "no crests" instructions — it will
 * sometimes draw its own stray headline or invented badge just above the
 * reserved band. Fading from further up gives that failure mode less clean
 * space to land in, on top of it being covered outright wherever it overlaps
 * the real composited crests.
 */
function fullTimeFadeSvg(): string {
  const fadeTop = CREST_ROW_CENTER_Y - 380;
  return `
  <defs>
    <linearGradient id="ft-fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#05070d" stop-opacity="0.3"/>
      <stop offset="40%" stop-color="#05070d" stop-opacity="0.65"/>
      <stop offset="100%" stop-color="#05070d" stop-opacity="0.94"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${fadeTop}" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT - fadeTop}" fill="url(#ft-fade)"/>
`;
}

/** Competition name flanked by thin rules, sitting just above the crest row. */
function competitionDividerSvg(): string {
  const y = CREST_ROW_CENTER_Y - 140;
  const halfLabelWidth = (COMPETITION_LABEL.length * 15 + 40) / 2;
  return `
  <text x="${IMAGE_WIDTH / 2}" y="${y + 6}" text-anchor="middle" ${TEXT_SHADOW_ATTRS}
        font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="22" font-weight="700"
        fill="#ffffff" letter-spacing="3">${COMPETITION_LABEL}</text>
  <line x1="${BAR_PADDING}" y1="${y}" x2="${IMAGE_WIDTH / 2 - halfLabelWidth}" y2="${y}"
        stroke="#000000" stroke-opacity="0.55" stroke-width="4"/>
  <line x1="${IMAGE_WIDTH / 2 + halfLabelWidth}" y1="${y}" x2="${IMAGE_WIDTH - BAR_PADDING}" y2="${y}"
        stroke="#000000" stroke-opacity="0.55" stroke-width="4"/>
  <line x1="${BAR_PADDING}" y1="${y}" x2="${IMAGE_WIDTH / 2 - halfLabelWidth}" y2="${y}"
        stroke="#ffffff" stroke-opacity="0.9" stroke-width="1.5"/>
  <line x1="${IMAGE_WIDTH / 2 + halfLabelWidth}" y1="${y}" x2="${IMAGE_WIDTH - BAR_PADDING}" y2="${y}"
        stroke="#ffffff" stroke-opacity="0.9" stroke-width="1.5"/>
`;
}

/**
 * The score itself, centered in the vertical gap the prompt asks the model
 * to leave clear between the two model-drawn crests (see
 * FULL_TIME_CONSTRAINTS in prompt-builder.ts) — every digit code-rendered so
 * it's always exactly right, same principle as the old top-bar score.
 */
function fullTimeScoreSvg(event: MatchEvent): string {
  const scoreText = `${event.home.score} - ${event.away.score}`;
  return `
  <text x="${IMAGE_WIDTH / 2}" y="${CREST_ROW_CENTER_Y + 40}" text-anchor="middle" ${TEXT_SHADOW_ATTRS}
        font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="104" font-weight="900"
        fill="#ffffff">${escapeXml(scoreText)}</text>
`;
}

/**
 * Full-time scorers list: one centered column ordered by minute, broadcast
 * style ("31'  |  P. GROSS"), code-rendered beneath the crest row so every
 * name is spelled exactly right (the AI image prompt reserves this band —
 * see FULL_TIME_CONSTRAINTS in prompt-builder.ts). Skipped when empty.
 */
function fullTimeScorersSvg(entries: readonly FullTimeScorer[]): string {
  if (entries.length === 0) return '';
  const sorted = entries.slice().sort((a, b) => {
    const aKey = a.minute * 1000 + (a.stoppageMinute ?? 0);
    const bKey = b.minute * 1000 + (b.stoppageMinute ?? 0);
    return aKey - bKey;
  });
  const top = CREST_ROW_CENTER_Y + 110;
  return sorted
    .map((entry, index) => {
      const y = top + index * SCORERS_ROW_HEIGHT;
      return `<text x="${IMAGE_WIDTH / 2}" y="${y}" text-anchor="middle" ${TEXT_SHADOW_ATTRS} font-family="${OVERLAY_FONT_FAMILY}, sans-serif" font-size="27" font-weight="700" fill="#f4f6fa" letter-spacing="1">${escapeXml(scorerLabel(entry))}</text>`;
    })
    .join('\n');
}

export type ComposeEventImageOptions = {
  /** Full-time only: confirmed scorers to list beneath the crest row, in code-rendered text. */
  scorers?: readonly FullTimeScorer[] | undefined;
  /** Full-time only: real crest images to composite in place of the model-drawn crests. */
  crests?: FullTimeCrests | undefined;
};

/**
 * Composes the final 1024×1536 JPEG from generated (or fallback) artwork
 * plus a deterministic overlay. The overlay always draws in code — never
 * left to the image model — because model-rendered text is unreliable
 * (garbled ampersands, multi-line wraps, long names); the prompt
 * (prompt-builder.ts) only asks the model to leave the bands this overlay
 * occupies visually calm. Full-time gets its own score-card layout (crest
 * row + centered score + competition line + scorers list); every other
 * event type gets the top scoreboard bar + bottom player caption.
 */
export async function composeEventImage(
  background: Buffer,
  event: MatchEvent,
  options: ComposeEventImageOptions = {},
): Promise<Buffer> {
  const svgFragments: string[] =
    event.type === 'FULL_TIME'
      ? [OVERLAY_FONT_FACE_SVG, fullTimeFadeSvg(), competitionDividerSvg(), fullTimeScoreSvg(event)]
      : [OVERLAY_FONT_FACE_SVG, scoreboardSvg(event), captionSvg(event)];
  if (event.type === 'FULL_TIME' && options.scorers?.length) {
    svgFragments.push(fullTimeScorersSvg(options.scorers));
  }

  try {
    const svg = `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  ${svgFragments.join('\n')}
</svg>`;
    const crestLayers =
      event.type === 'FULL_TIME' && options.crests ? await crestCompositeLayers(options.crests) : [];
    const pipeline = sharp(background)
      .rotate()
      .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: 'attention' })
      .composite([...crestLayers, { input: Buffer.from(svg), top: 0, left: 0 }]);
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
