import type { MatchEvent, MatchEventType } from '../domain/match-event.js';
import type { RuntimeSettings } from './settings.js';

/**
 * Default publishing policy (section 1). Kick-off/half-time, yellow cards and
 * routine substitutions never reach the normalizer's taxonomy, so they are
 * excluded upstream; this module decides among the remaining types.
 */
const DEFAULT_PUBLISHED_TYPES: ReadonlySet<MatchEventType> = new Set([
  'GOAL',
  'OWN_GOAL',
  'RED_CARD',
  'PENALTY_MISSED',
  'VAR',
  'FULL_TIME',
]);

/** Confirmation window in seconds before a goal may be published. */
export const GOAL_CONFIRMATION_SECONDS = 12; // within the 8–15s window

export type EligibilityDecision =
  | { eligible: true; confirmationDelaySeconds: number }
  | { eligible: false; reason: string };

export function evaluateEligibility(
  event: MatchEvent,
  settings: RuntimeSettings,
): EligibilityDecision {
  if (!DEFAULT_PUBLISHED_TYPES.has(event.type)) {
    return { eligible: false, reason: `event type ${event.type} is not publishable` };
  }
  if (!settings.enabledEventTypes.has(event.type)) {
    return { eligible: false, reason: `event type ${event.type} disabled by settings` };
  }
  if (event.status === 'OVERTURNED') {
    return { eligible: false, reason: 'event already overturned' };
  }

  // Goals wait out the VAR window; red cards / penalty outcomes / full time
  // publish after the provider marks them confirmed (short safety delay).
  const delay =
    event.type === 'GOAL' || event.type === 'OWN_GOAL'
      ? GOAL_CONFIRMATION_SECONDS
      : event.type === 'FULL_TIME'
        ? 5
        : 8;

  return { eligible: true, confirmationDelaySeconds: delay };
}
