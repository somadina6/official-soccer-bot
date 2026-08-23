import type { MatchEvent } from '../domain/match-event.js';

/**
 * Prompts are versioned application code (plan section 8). The version is
 * persisted on the image job and baked into the immutable storage path, so a
 * wording change never silently overwrites previously generated artwork.
 */
export const IMAGE_PROMPT_VERSION = 'prompt-v4';

const SHARED_CONSTRAINTS = `
No scoreboard, watermark, duplicate people, distorted limbs or extra fingers.
Kit branding (club crests, sponsor marks, league sleeve patches) is allowed;
do not invent a scoreboard or overlay lettering.
Leave the lower third of the frame calmer so a deterministic overlay can be added later.
`.trim();

const CAMERA_STYLE = `
Packed English football stadium at night, supporters softly blurred in the
background, dramatic floodlights, shallow depth of field, 85mm sports
photography, 1/1000 second shutter speed, crisp subject, cinematic colour
grading.
`.trim();

/**
 * The normalized event does not attribute the player to a side, so the kit
 * is a best-effort heuristic: a goal is credited to the side the scoreboard
 * currently favours (mirrors the retired background-mood logic).
 */
function kitSideFor(event: MatchEvent): MatchEvent['home'] {
  const homeFavoured = event.home.score >= event.away.score;
  return event.type === 'OWN_GOAL' ? (homeFavoured ? event.away : event.home) : homeFavoured ? event.home : event.away;
}

function coloursLineFor(side: MatchEvent['home']): string {
  return side.colours.length > 0 ? ` in ${side.colours.join(' and ')}` : '';
}

function kitLineFor(event: MatchEvent): string {
  const side = kitSideFor(event);
  return `Wearing an authentic ${side.name} match kit${coloursLineFor(side)} with club crest, sponsor logos, and league badges visible.`;
}

function bothKitsLine(event: MatchEvent): string {
  return `Players wearing authentic ${event.home.name} kits${coloursLineFor(event.home)} against ${event.away.name} kits${coloursLineFor(event.away)}, club crests, sponsor logos, and league badges visible.`;
}

function subjectFor(event: MatchEvent): string {
  return event.player?.name ?? 'a football player';
}

/** Football-notation minute label, e.g. "78'" or "90+3'". */
function minuteLabel(event: MatchEvent): string {
  return event.stoppageMinute ? `${event.minute}+${event.stoppageMinute}'` : `${event.minute}'`;
}

/**
 * Narrative colour for when in the match this happened, so otherwise
 * identical event types don't render as interchangeable moments.
 */
function momentLineFor(event: MatchEvent): string {
  const minute = minuteLabel(event);
  if (event.stoppageMinute) {
    return `This happens in the ${minute} minute, deep into a tense stoppage-time finish, the floodlit crowd on its feet.`;
  }
  if (event.minute <= 15) {
    return `This happens early in the match, the ${minute} minute, with the crowd still settling in.`;
  }
  if (event.minute >= 80) {
    return `This happens late in the match, the ${minute} minute, in a frantic, high-stakes finale.`;
  }
  return `This happens in the ${minute} minute of a hard-fought match.`;
}

/** Credits the assist when one is known, used only on goal-scoring events. */
function assistLineFor(event: MatchEvent): string {
  return event.assist?.name ? ` Moments earlier, ${event.assist.name} supplied the assist.` : '';
}

/** Builds the photorealistic editorial prompt for one confirmed event. */
export function buildEventImagePrompt(event: MatchEvent): string {
  const player = subjectFor(event);
  const kitLine = kitLineFor(event);
  const momentLine = momentLineFor(event);

  switch (event.type) {
    case 'GOAL':
    case 'OWN_GOAL':
      return `
Photorealistic editorial sports photograph of ${player}
celebrating immediately after scoring, full-body action pose, sprinting toward
the corner, authentic athletic movement, balanced natural anatomy, realistic
hands and face, visible emotion, sweat and fabric detail.

${momentLine}${assistLineFor(event)}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'RED_CARD':
      return `
Photorealistic editorial sports photograph of ${player}
reacting with disbelief moments after a sending-off, head bowed or hands on
head, walking away from the referee, authentic athletic posture, balanced
natural anatomy, realistic hands and face, raw emotion, sweat and fabric
detail. The referee is out of frame.

${momentLine}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'PENALTY_MISSED':
      return `
Photorealistic editorial sports photograph of ${player}
in the instant of anguish after a missed penalty, hands rising toward the
face, body turning away from the goal, authentic athletic movement, balanced
natural anatomy, realistic hands and face, visible despair, sweat and fabric
detail.

${momentLine}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'VAR':
      return `
Photorealistic editorial sports photograph of tense footballers waiting on
the pitch during a video review, players with hands on hips looking toward
the sideline, authentic athletic posture, balanced natural anatomy, realistic
hands and faces. No screens with readable text.

${momentLine}

${bothKitsLine(event)} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'FULL_TIME':
      return `
Photorealistic editorial wide-angle sports photograph of exhausted
footballers at the final whistle, some embracing, some collapsed to their
knees on the pitch, authentic athletic posture, balanced natural anatomy,
realistic hands and faces, mixed elation and dejection.
${event.home.score === event.away.score ? 'The match ends level, an evenly shared mood of relief and frustration.' : Math.abs(event.home.score - event.away.score) >= 3 ? 'One side is euphoric after a dominant scoreline, the other visibly deflated.' : 'One side is narrowly triumphant, the other crestfallen after a close-fought result.'}

${bothKitsLine(event)} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();
  }
}
