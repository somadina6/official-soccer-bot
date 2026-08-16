import type { MatchEvent } from '../domain/match-event.js';

/**
 * Prompts are versioned application code (plan section 8). The version is
 * persisted on the image job and baked into the immutable storage path, so a
 * wording change never silently overwrites previously generated artwork.
 */
export const IMAGE_PROMPT_VERSION = 'prompt-v2';

const SHARED_CONSTRAINTS = `
No scoreboard, lettering, watermark, duplicate people, distorted limbs,
extra fingers or official branding. No club crests, sponsor marks or
league logos anywhere. Leave the lower third of the frame calmer so a
deterministic overlay can be added later.
`.trim();

const CAMERA_STYLE = `
Packed English football stadium at night, supporters softly blurred in the
background, dramatic floodlights, shallow depth of field, 85mm sports
photography, 1/1000 second shutter speed, crisp subject, cinematic colour
grading.
`.trim();

/**
 * The normalized event does not attribute the player to a side, so the kit
 * colour is a best-effort heuristic: a goal is credited to the side the
 * scoreboard currently favours (mirrors the retired background-mood logic).
 */
function kitColourFor(event: MatchEvent): string {
  const homeFavoured = event.home.score >= event.away.score;
  const scoringSide =
    event.type === 'OWN_GOAL' ? (homeFavoured ? event.away : event.home) : homeFavoured ? event.home : event.away;
  return scoringSide.colours[0] ?? '#6CADDF';
}

function subjectFor(event: MatchEvent): string {
  return event.player?.name ?? 'a football player';
}

/** Builds the photorealistic editorial prompt for one confirmed event. */
export function buildEventImagePrompt(event: MatchEvent): string {
  const player = subjectFor(event);
  const kitColor = kitColourFor(event);
  const kitLine = `Wearing a generic ${kitColor} football kit without logos, badges, sponsors or readable text.`;

  switch (event.type) {
    case 'GOAL':
    case 'OWN_GOAL':
      return `
Photorealistic editorial sports photograph of ${player}
celebrating immediately after scoring, full-body action pose, sprinting toward
the corner, authentic athletic movement, balanced natural anatomy, realistic
hands and face, visible emotion, sweat and fabric detail.

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

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'VAR':
      return `
Photorealistic editorial sports photograph of tense footballers waiting on
the pitch during a video review, players with hands on hips looking toward
the sideline, authentic athletic posture, balanced natural anatomy, realistic
hands and faces. No screens with readable text.

${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'FULL_TIME':
      return `
Photorealistic editorial wide-angle sports photograph of exhausted
footballers at the final whistle, some embracing, some collapsed to their
knees on the pitch, authentic athletic posture, balanced natural anatomy,
realistic hands and faces, mixed elation and dejection.

${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();
  }
}
