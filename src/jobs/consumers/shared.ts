import type { EventState } from '../../domain/match-event.js';
import { MatchEventSchema, type MatchEvent } from '../../domain/match-event.js';
import { getSupabase } from '../../supabase/client.js';

export async function setEventState(matchEventId: number, state: EventState): Promise<void> {
  const { error } = await getSupabase()
    .from('match_events')
    .update({ state, updated_at: new Date().toISOString() })
    .eq('id', matchEventId);
  if (error) throw new Error(`state update failed for event ${matchEventId}: ${error.message}`);
}

export type EventRow = {
  id: number;
  idempotency_key: string;
  fixture_id: number;
  state: string;
  event_type: string;
  event: MatchEvent;
  rawPayload: unknown;
};

export async function loadEvent(matchEventId: number): Promise<EventRow> {
  const { data, error } = await getSupabase()
    .from('match_events')
    .select('id, idempotency_key, fixture_id, state, event_type, normalized, raw_payload')
    .eq('id', matchEventId)
    .single();
  if (error || !data) throw new Error(`match_event ${matchEventId} not found: ${error?.message}`);
  return {
    id: data.id,
    idempotency_key: data.idempotency_key,
    fixture_id: data.fixture_id,
    state: data.state,
    event_type: data.event_type,
    event: MatchEventSchema.parse(data.normalized),
    rawPayload: data.raw_payload,
  };
}
