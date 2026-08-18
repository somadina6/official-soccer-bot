import { fetchMatch } from '../providers/sportsapi/rest-client.js';

export type FixtureMatchStatus = 'finished' | 'live' | 'postponed' | 'scheduled' | 'unknown';

/**
 * Reads SportsAPI match status from a raw `/match/{id}` payload.
 * Provider shapes vary; this is deliberately tolerant.
 */
export function matchStatusFromPayload(payload: unknown): FixtureMatchStatus {
  if (!payload || typeof payload !== 'object') return 'unknown';
  const root = payload as Record<string, unknown>;
  const event =
    (root.event as Record<string, unknown> | undefined) ??
    (root.data as Record<string, unknown> | undefined) ??
    root;
  const status = event.status;
  const raw =
    typeof status === 'string'
      ? status
      : status && typeof status === 'object'
        ? String(
            (status as { type?: unknown; description?: unknown }).type ??
              (status as { description?: unknown }).description ??
              '',
          )
        : '';
  const value = raw.toLowerCase();
  if (
    value.includes('finish') ||
    value.includes('ended') ||
    value === 'ft' ||
    value === 'aet' ||
    value === 'ap'
  ) {
    return 'finished';
  }
  if (value.includes('postpone') || value.includes('cancel') || value.includes('abandon')) {
    return 'postponed';
  }
  if (value.includes('progress') || value.includes('live') || value.includes('halftime') || value === 'ht') {
    return 'live';
  }
  if (value.includes('notstarted') || value.includes('not started') || value === 'ns' || value.includes('scheduled')) {
    return 'scheduled';
  }
  return 'unknown';
}

export function isMatchFinished(fixtureStatus: string, hasFullTimeEvent: boolean): boolean {
  return fixtureStatus === 'finished' || hasFullTimeEvent;
}

export async function fetchProviderMatchStatus(providerMatchId: string): Promise<FixtureMatchStatus> {
  const payload = await fetchMatch(providerMatchId);
  return matchStatusFromPayload(payload);
}
