import type { CommentarySituation } from '../domain/content.js';
import type { MatchEvent } from '../domain/match-event.js';

const LATE_MINUTE = 85;

function isLate(event: MatchEvent): boolean {
  return event.minute >= LATE_MINUTE;
}

function hasPenaltySavedFact(approvedContext: string[]): boolean {
  return approvedContext.some(fact => fact.toLowerCase() === 'penalty saved');
}

/**
 * Derives the commentary situation from the confirmed event. A goal adds one
 * to one side, so the post-goal scoreline implies the prior state: level means
 * equalizer, a one-goal gap means a go-ahead, two or more means insurance.
 */
export function classifySituation(
  event: MatchEvent,
  approvedContext: string[] = [],
): CommentarySituation {
  switch (event.type) {
    case 'RED_CARD':
      return 'red_card';
    case 'VAR':
      return 'var_overturn';
    case 'FULL_TIME':
      return 'full_time';
    case 'PENALTY_MISSED':
      return hasPenaltySavedFact(approvedContext) ? 'penalty_saved' : 'penalty_missed';
    case 'GOAL':
    case 'OWN_GOAL': {
      const home = event.home.score;
      const away = event.away.score;
      if (home === away && home > 0) return 'equalizer';
      if (Math.abs(home - away) === 1 && isLate(event)) return 'late_winner';
      return event.type === 'OWN_GOAL' ? 'own_goal' : 'goal';
    }
  }
}

export const SITUATION_GUIDANCE: Record<CommentarySituation, string> = {
  goal: 'Lead with emotion or the quality of the finish. Do not open with GOOOOAL, GOAL!, or stretched goal spellings.',
  equalizer: 'Emphasize the change in momentum. The match just swung back to level.',
  late_winner: 'This is the most dramatic register. Peak emotion is allowed. Still stay factual.',
  own_goal: 'Acknowledge the cruelty of the moment without mocking the player\'s character or identity.',
  red_card: 'Banter about the football consequence — not the player\'s character. Naming the player is optional; the team and the tactical cost are enough.',
  penalty_saved: 'Make the goalkeeper the hero rather than humiliating the taker. Prefer the keeper\'s name when it is in the context dictionary.',
  penalty_missed: 'The chance is gone. Do not pile onto the taker; keep it about the miss and the match state.',
  var_overturn: 'Be clear before being funny. Lead with the reversed decision, then the score, then one dry line.',
  full_time: 'Summarize the match\'s story. A question is allowed only if the assigned style is question.',
};

/** Goals (including equalizers and late winners) still have to name the scorer. */
export function requiresPlayerName(situation: CommentarySituation): boolean {
  return (
    situation === 'goal' ||
    situation === 'equalizer' ||
    situation === 'late_winner' ||
    situation === 'own_goal' ||
    situation === 'penalty_missed'
  );
}
