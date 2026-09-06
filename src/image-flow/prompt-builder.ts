import type { MatchEvent } from '../domain/match-event.js';

/**
 * Prompts are versioned application code (plan section 8). The version is
 * persisted on the image job and baked into the immutable storage path, so a
 * wording change never silently overwrites previously generated artwork.
 */
export const IMAGE_PROMPT_VERSION = 'prompt-v12';

const SHARED_CONSTRAINTS = `
No duplicate people, distorted limbs, or extra fingers. Kit branding (club
crests, sponsor marks, league sleeve patches) is allowed. No watermark, and
no stray or invented text anywhere in the image beyond what is specified
below.
`.trim();

const EVENT_LABELS: Record<MatchEvent['type'], string> = {
  GOAL: 'GOAL',
  OWN_GOAL: 'OWN GOAL',
  RED_CARD: 'RED CARD',
  PENALTY_MISSED: 'PENALTY MISSED',
  VAR: 'VAR DECISION',
  FULL_TIME: 'FULL-TIME',
};

/**
 * Model-rendered scoreboard + caption instructions, replacing the old
 * deterministic Sharp overlay for AI-generated events (visual-composer.ts
 * skips its overlay for this pipeline — see ComposeEventImageOptions).
 * Tested across several samples (long team names, double-digit scores,
 * accented names) and the model rendered every case correctly; still
 * inherently probabilistic compared to code-drawn text, so keep an eye on
 * production output.
 */
function scoreboardInstructionsFor(event: MatchEvent): string {
  const label = EVENT_LABELS[event.type];
  const home = event.home.name.toUpperCase();
  const away = event.away.name.toUpperCase();
  const requiredStrings = [
    `"${home}"`,
    `"${away}"`,
    `"${event.home.score}"`,
    `"${event.away.score}"`,
    `"${label}"`,
  ];

  let playerBlock = '';
  if (event.player && event.type !== 'FULL_TIME') {
    const player = event.player.name.toUpperCase();
    const minute = minuteLabel(event);
    playerBlock = `
2. Near the bottom of the frame, large bold white capital letters reading
   "${player}" on one line, and directly below it, smaller white text
   reading "${minute}".
`;
    requiredStrings.push(`"${player}"`, `"${minute}"`);
  }

  return `
This image MUST include the following text and graphic elements, rendered
crisply and accurately as part of the composition, not a caption added
afterward:

1. A solid dark navy bar across the very top of the frame, about one eighth
   of the image height. On the far left of that bar, the text "${home}" in
   bold white sans-serif, with the number "${event.home.score}" in large
   bold white directly beneath it. On the far right of that bar, the text
   "${away}" in bold white sans-serif, with the number "${event.away.score}"
   in large bold white directly beneath it. In the exact center of that bar,
   a white rounded pill outline containing the words "${label}" in bold
   white capital letters. If a team name is long, wrap it onto two lines
   rather than letting it overlap the pill.
${playerBlock}
Every character in ${requiredStrings.join(', ')} must be spelled correctly,
letter for letter, legible, and exactly as given above — no invented,
duplicated, or garbled text anywhere else in the image.
`.trim();
}

const CAMERA_STYLE = `
Vertical portrait orientation. Tight, cinematic close-up framed from the
chest up, shot like a modern official football club account hero image:
long telephoto lens, shallow depth of field, the packed floodlit stadium
reduced to soft glowing bokeh behind the subject. Punchy contemporary sports
colour grade, deep contrast, cool shadow tones, warm accurate skin tones,
crisp tack-sharp subject detail, freeze-frame sports photography.
`.trim();

/**
 * Pose banks so repeated events don't all render the same frozen gesture.
 * Selection is deterministic per event (see seedFor/pick below), not random
 * per call, so an idempotent re-composite of the same event never drifts.
 */
const GOAL_POSES = [
  'roaring with a clenched fist driven upward, chin lifted, eyes blazing with triumph',
  'sprinting mid-stride with both arms flung wide, mouth open in a joyous shout',
  'dropping to one knee, fists pulled down hard, head thrown back in release',
  'cupping a hand to an ear, staring into the crowd with a fierce, taunting grin',
  'leaping with both fists punching skyward, shirt rippling mid-jump',
  'sliding on both knees, arms spread wide, pure elation across the face',
  'pointing decisively toward the crowd, jaw clenched, eyes locked and intense',
  'beating both fists against the chest, a guttural roar of release',
] as const;

const OWN_GOAL_POSES = [
  'hands clamped over the face, shoulders hunched in disbelief',
  'both hands gripping the back of the head, mouth open in a silent groan',
  'bent forward with hands on knees, staring blankly at the turf',
  'turning away sharply, one arm thrown up in frustration',
  'crouched low, forearms pressed against the eyes, utterly crestfallen',
] as const;

const RED_CARD_POSES = [
  'head bowed, hands pressed to the top of the head in disbelief',
  'arms spread wide in protest, mouth open mid-argument',
  'walking away with shoulders slumped, staring at the ground',
  'hands gripping the jersey collar, eyes wide with shock',
  'turning away with one hand raised as if pleading the decision',
] as const;

const PENALTY_MISSED_POSES = [
  'both hands clutching the top of the head, eyes squeezed shut',
  'bent double, hands on knees, staring in disbelief at the goal',
  'dropping to both knees, fists pressed against the forehead',
  'turning away sharply with one arm thrown over the face',
  'standing frozen, hands open at the sides, shoulders sagging',
] as const;

/** Stable per-event hash so the same event always picks the same pose. */
function seedFor(event: MatchEvent): number {
  const raw = [
    event.matchId,
    event.incidentId ?? '',
    event.type,
    event.minute,
    event.stoppageMinute ?? '',
    event.player?.name ?? '',
  ].join(':');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function pick<T>(items: readonly T[], seed: number): T {
  return items[seed % items.length] as T;
}

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
 * Full-time is a graphic, not a photo, but now also model-rendered — see
 * scoreboardInstructionsFor. The band directly below the top bar is reserved
 * for a code-drawn scorers list (visual-composer.ts scorersSvg), composited
 * on afterward, so the model must keep that region visually calm.
 */
const FULL_TIME_CONSTRAINTS = `
No players, no people, no photographs of humans in the backdrop art. Crests
must not be duplicated, invented beyond the two named clubs, or distorted.
No watermark, and no stray or invented text anywhere in the image beyond
what is specified below. Leave the band directly beneath the top scoreboard
bar, roughly the next quarter of the frame, visually calm and uncluttered —
no crests, text, or important detail placed there — since a scorers list is
composited over that region afterward. Keep the two crests and the main
composition centered in the lower two-thirds of the frame.
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
    case 'GOAL': {
      const pose = pick(GOAL_POSES, seedFor(event));
      return `
Photorealistic close-up sports photograph of ${player}, chest-up framing,
captured moments after scoring: ${pose}. Authentic athletic posture,
balanced natural anatomy, realistic hands and face, sweat and fabric detail.
A teammate may be softly out of focus in the far background, but ${player}
is the single clear hero of the frame.

${momentLine}${assistLineFor(event)}${goalContextLineFor(event)}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}

${scoreboardInstructionsFor(event)}
`.trim();
    }

    case 'OWN_GOAL': {
      const pose = pick(OWN_GOAL_POSES, seedFor(event));
      return `
Photorealistic close-up sports photograph of ${player}, chest-up framing,
reacting with anguish and disbelief moments after an own goal: ${pose}.
Authentic athletic posture, balanced natural anatomy, realistic hands and
face, raw emotion, sweat and fabric detail. An opponent may be softly out of
focus in the far background, showing restrained, sportsmanlike celebration
rather than mockery.

${momentLine}${goalContextLineFor(event)}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}

${scoreboardInstructionsFor(event)}
`.trim();
    }

    case 'RED_CARD': {
      const pose = pick(RED_CARD_POSES, seedFor(event));
      return `
Photorealistic close-up sports photograph of ${player}, chest-up framing,
reacting with disbelief moments after a sending-off: ${pose}. Authentic
athletic posture, balanced natural anatomy, realistic hands and face, raw
emotion, sweat and fabric detail. The referee is out of frame.

${momentLine}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}

${scoreboardInstructionsFor(event)}
`.trim();
    }

    case 'PENALTY_MISSED': {
      const pose = pick(PENALTY_MISSED_POSES, seedFor(event));
      return `
Photorealistic close-up sports photograph of ${player}, chest-up framing, in
the instant of anguish after a missed penalty: ${pose}. Authentic athletic
posture, balanced natural anatomy, realistic hands and face, visible
despair, sweat and fabric detail.

${momentLine}

${kitLine} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}

${scoreboardInstructionsFor(event)}
`.trim();
    }

    case 'VAR':
      return `
Photorealistic close-up sports photograph of tense footballers waiting on
the pitch during a video review, chest-up framing, players with hands on
hips looking toward the sideline, authentic athletic posture, balanced
natural anatomy, realistic hands and faces. No screens with readable text.

${momentLine}

${bothKitsLine(event)} ${CAMERA_STYLE}

${SHARED_CONSTRAINTS}

${scoreboardInstructionsFor(event)}
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

${scoreboardInstructionsFor(event)}
`.trim();
    }
  }
}
