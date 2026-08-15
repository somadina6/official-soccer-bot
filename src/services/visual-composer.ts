import sharp from 'sharp';
import type { MatchEvent } from '../domain/match-event.js';

const SIZE = 1024;

const EVENT_LABELS: Record<MatchEvent['type'], string> = {
  GOAL: 'GOAL',
  OWN_GOAL: 'OWN GOAL',
  RED_CARD: 'RED CARD',
  PENALTY_MISSED: 'PENALTY MISSED',
  VAR: 'VAR DECISION',
  FULL_TIME: 'FULL TIME',
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Deterministic score-card overlay (section 8): the image model paints the
 * mood, but every factual element — event label, player, minute, score, team
 * names — is rendered by code so it is always exactly right.
 */
function overlaySvg(event: MatchEvent): string {
  const label = EVENT_LABELS[event.type];
  const minute = event.stoppageMinute
    ? `${event.minute}+${event.stoppageMinute}'`
    : `${event.minute}'`;
  const player = event.player ? escapeXml(event.player.name) : '';
  const scoreline =
    `${escapeXml(event.home.name)}  ${event.home.score} \u2013 ${event.away.score}  ` +
    escapeXml(event.away.name);
  const detailLine = [player, event.type === 'FULL_TIME' ? '' : minute]
    .filter(Boolean)
    .join('  \u00b7  ');

  return `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.88"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${SIZE - 320}" width="${SIZE}" height="320" fill="url(#fade)"/>
  <text x="64" y="${SIZE - 216}" font-family="Arial Black, Arial, sans-serif" font-size="64"
        font-weight="900" fill="#ffffff" letter-spacing="2">${label}</text>
  ${detailLine ? `<text x="64" y="${SIZE - 140}" font-family="Arial, sans-serif" font-size="44"
        font-weight="700" fill="#ffffff">${detailLine}</text>` : ''}
  <text x="64" y="${SIZE - 64}" font-family="Arial, sans-serif" font-size="38"
        font-weight="600" fill="#e8e8e8">${scoreline}</text>
</svg>`;
}

/** Composes the final 1024×1024 WebP post image from a prepared background. */
export async function composeEventImage(background: Buffer, event: MatchEvent): Promise<Buffer> {
  return sharp(background)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .composite([{ input: Buffer.from(overlaySvg(event)), top: 0, left: 0 }])
    .webp({ quality: 88 })
    .toBuffer();
}

/** Neutral fallback background when no prepared artwork exists for a fixture. */
export async function solidFallbackBackground(colours: string[]): Promise<Buffer> {
  const primary = colours[0] ?? '#12233d';
  const secondary = colours[1] ?? '#0b1524';
  const svg = `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="30%" r="80%">
      <stop offset="0%" stop-color="${escapeXml(primary)}"/>
      <stop offset="100%" stop-color="${escapeXml(secondary)}"/>
    </radialGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#glow)"/>
</svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 88 }).toBuffer();
}
