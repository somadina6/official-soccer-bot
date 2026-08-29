import type { MatchEvent } from '../domain/match-event.js';

/**
 * Prompts are versioned application code (plan section 8). The version is
 * persisted on the image job and baked into the immutable storage path, so a
 * wording change never silently overwrites previously generated artwork.
 */
export const IMAGE_PROMPT_VERSION = 'prompt-v9';

const SHARED_CONSTRAINTS = `
No scoreboard, watermark, duplicate people, distorted limbs or extra fingers.
Kit branding (club crests, sponsor marks, league sleeve patches) is allowed;
do not invent a scoreboard or overlay lettering.
Leave a calm margin at the very top and bottom of the frame so a
deterministic scoreboard bar and caption can be composited afterward.
`.trim();

const CAMERA_STYLE = `
Vertical portrait orientation. Tight, cinematic close-up framed from the
chest up, shot like a modern official football club account hero image:
long telephoto lens, shallow depth of field, the packed floodlit stadium
reduced to soft glowing bokeh behind the subject. Punchy contemporary sports
colour grade, deep contrast, cool shadow tones, warm accurate skin tones,
crisp tack-sharp subject detail, freeze-frame sports photography.
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

function crestLineFor(side: MatchEvent['home']): string {
  return `${side.name} club crest${coloursLineFor(side)}`;
}

/**
 * Full-time is a graphic, not a photo. The scoreline itself is left to the
 * deterministic overlay composed on top afterward (visual-composer.ts),
 * since image models render digits and text unreliably.
 */
const FULL_TIME_CONSTRAINTS = `
No players, no people, no photographs of humans. No scoreboard, score
digits, or any lettering — the accurate scoreline and result label are added
afterward by a deterministic overlay. No watermark. Crests must not be
duplicated, invented beyond the two named clubs, or distorted. Leave a calm
margin at the very top of the frame for the scoreboard bar.
`.trim();

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

/**
 * The side whose score benefits from this goal: the scorer's side for a
 * GOAL, but the *other* side for an OWN_GOAL, since kitSideFor identifies
 * the unlucky player who put it in his own net.
 */
function beneficiarySideFor(event: MatchEvent): MatchEvent['home'] {
  const scorerSide = kitSideFor(event);
  if (event.type !== 'OWN_GOAL') {
    return scorerSide;
  }
  return scorerSide === event.home ? event.away : event.home;
}

/**
 * Scoreline drama for a goal or own goal, so an opener, an equalizer, a
 * go-ahead strike, and a lead extension don't all read as the same generic
 * celebration. kitSideFor always credits the goal to the side the
 * scoreboard currently favours (or ties), so the beneficiary's score is
 * never lower than the opponent's here.
 */
function goalContextLineFor(event: MatchEvent): string {
  const beneficiary = beneficiarySideFor(event);
  const opponent = beneficiary === event.home ? event.away : event.home;
  const own = event.type === 'OWN_GOAL';
  const totalGoals = event.home.score + event.away.score;
  const margin = beneficiary.score - opponent.score;

  if (totalGoals === 1) {
    return own
      ? ` An early own goal hands ${beneficiary.name} a ${beneficiary.score}-${opponent.score} lead.`
      : ` It is the opening goal of the match.`;
  }
  if (margin === 0) {
    return own
      ? ` The own goal levels the score at ${beneficiary.score}-${opponent.score}.`
      : ` The goal levels the score at ${beneficiary.score}-${opponent.score}.`;
  }
  if (margin === 1) {
    return own
      ? ` The own goal puts ${beneficiary.name} ahead ${beneficiary.score}-${opponent.score}.`
      : ` The goal puts ${beneficiary.name} ahead ${beneficiary.score}-${opponent.score}.`;
  }
  return own
    ? ` The own goal extends ${beneficiary.name}'s lead to ${beneficiary.score}-${opponent.score}.`
    : ` The goal extends ${beneficiary.name}'s lead to ${beneficiary.score}-${opponent.score}.`;
}

/** Builds the photorealistic editorial prompt for one confirmed event. */
export function buildEventImagePrompt(event: MatchEvent): string {
  const player = subjectFor(event);
  const kitLine = kitLineFor(event);
  const momentLine = momentLineFor(event);

  switch (event.type) {
    case 'GOAL':
      return `
Photorealistic close-up sports photograph of ${player}
mid-celebration immediately after scoring, chest-up framing, raw unfiltered
emotion on the face — roar, clenched fist, or head thrown back — authentic
athletic posture, balanced natural anatomy, realistic hands and face, sweat
and fabric detail. A teammate may be softly out of focus in the far
background, but ${player} is the single clear hero of the frame.

${momentLine}${assistLineFor(event)}${goalContextLineFor(event)}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'OWN_GOAL':
      return `
Photorealistic close-up sports photograph of ${player}
reacting with anguish and disbelief moments after an own goal, chest-up
framing, hands on head or covering the face, authentic athletic posture,
balanced natural anatomy, realistic hands and face, raw emotion, sweat and
fabric detail. An opponent may be softly out of focus in the far background,
showing restrained, sportsmanlike celebration rather than mockery.

${momentLine}${goalContextLineFor(event)}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'RED_CARD':
      return `
Photorealistic close-up sports photograph of ${player}
reacting with disbelief moments after a sending-off, chest-up framing, head
bowed or hands on head, authentic athletic posture, balanced natural
anatomy, realistic hands and face, raw emotion, sweat and fabric detail. The
referee is out of frame.

${momentLine}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'PENALTY_MISSED':
      return `
Photorealistic close-up sports photograph of ${player}
in the instant of anguish after a missed penalty, chest-up framing, hands
rising toward the face, authentic athletic posture, balanced natural
anatomy, realistic hands and face, visible despair, sweat and fabric detail.

${momentLine}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'VAR':
      return `
Photorealistic close-up sports photograph of tense footballers waiting on
the pitch during a video review, chest-up framing, players with hands on
hips looking toward the sideline, authentic athletic posture, balanced
natural anatomy, realistic hands and faces. No screens with readable text.

${momentLine}

${bothKitsLine(event)} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}
`.trim();

    case 'FULL_TIME': {
      const margin = Math.abs(event.home.score - event.away.score);
      const moodLine =
        event.home.score === event.away.score
          ? 'The match ends level, a hard-fought, evenly shared result.'
          : margin >= 3
            ? 'A dominant, one-sided final scoreline.'
            : 'A close result, narrowly decided.';
      return `
Vertical portrait orientation. Full-time result graphic, no players, no people,
no photographs of humans. Clean, modern, cinematic sports broadcast graphic
style: the ${crestLineFor(event.home)} on the left facing the
${crestLineFor(event.away)} on the right, separated by a bold abstract
divider, set against a subtly blurred, floodlit stadium backdrop with punchy
contemporary colour grading. Balanced, centered composition with clear space
around each crest.

${moodLine}

${FULL_TIME_CONSTRAINTS}
`.trim();
    }
  }
}
