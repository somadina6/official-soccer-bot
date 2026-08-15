import { loadEnv } from '../config/env.js';
import type { BanterTone } from '../domain/content.js';
import type { MatchEventType } from '../domain/match-event.js';
import { getSupabase } from '../supabase/client.js';

/**
 * Runtime admin controls stored in `account_settings`. Environment variables
 * are the conservative bootstrap; database values let an operator flip the
 * kill switch or tone without redeploying. The MOST restrictive of env and DB
 * wins for publishing safety.
 */
export type RuntimeSettings = {
  publishingEnabled: boolean;
  dryRun: boolean;
  manualApproval: boolean;
  banterTone: BanterTone;
  enabledEventTypes: Set<MatchEventType>;
};

export async function loadRuntimeSettings(): Promise<RuntimeSettings> {
  const env = loadEnv();
  const { data } = await getSupabase()
    .from('account_settings')
    .select('key, value')
    .in('key', ['publishing_enabled', 'dry_run', 'manual_approval', 'banter_tone', 'enabled_event_types']);

  const map = new Map<string, unknown>((data ?? []).map(row => [row.key, row.value]));

  return {
    publishingEnabled: env.PUBLISHING_ENABLED && map.get('publishing_enabled') === true,
    dryRun: env.DRY_RUN || map.get('dry_run') === true,
    manualApproval: map.get('manual_approval') === true,
    banterTone: (map.get('banter_tone') as BanterTone) ?? env.BANTER_TONE,
    enabledEventTypes: new Set(
      (map.get('enabled_event_types') as MatchEventType[]) ?? [
        'GOAL',
        'OWN_GOAL',
        'RED_CARD',
        'PENALTY_MISSED',
        'VAR',
        'FULL_TIME',
      ],
    ),
  };
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const { error } = await getSupabase()
    .from('account_settings')
    .upsert({ key, value: value as never, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Failed to update setting ${key}: ${error.message}`);
}
