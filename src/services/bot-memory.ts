import type { StoredPrediction } from '../domain/influencer.js';
import { getSupabase } from '../supabase/client.js';

export type BotOpinion = {
  id: string;
  subject_type: string;
  subject_name: string;
  stance: string;
  evidence: unknown[];
  status: string;
};

export async function loadOpinionsForSubjects(names: string[]): Promise<BotOpinion[]> {
  if (names.length === 0) return [];
  const { data, error } = await getSupabase()
    .from('bot_opinions')
    .select('id, subject_type, subject_name, stance, evidence, status')
    .eq('status', 'active')
    .in('subject_name', names)
    .order('updated_at', { ascending: false })
    .limit(12);
  if (error) throw new Error(`bot_opinions lookup failed: ${error.message}`);
  return (data ?? []) as BotOpinion[];
}

export async function recordOpinions(input: {
  subjectType: string;
  subjectName: string;
  stances: string[];
  evidence: string[];
}): Promise<void> {
  if (input.stances.length === 0) return;
  const rows = input.stances.map(stance => ({
    subject_type: input.subjectType,
    subject_name: input.subjectName,
    stance,
    evidence: input.evidence,
    status: 'active',
    updated_at: new Date().toISOString(),
  }));
  const { error } = await getSupabase().from('bot_opinions').insert(rows);
  if (error) throw new Error(`bot_opinions insert failed: ${error.message}`);
}

export async function loadPredictionForFixture(fixtureId: string): Promise<StoredPrediction | null> {
  const { data, error } = await getSupabase()
    .from('bot_predictions')
    .select('id, fixture_id, prediction, post_id')
    .eq('fixture_id', fixtureId)
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`bot_predictions lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    fixtureId: data.fixture_id,
    prediction: data.prediction,
    postId: data.post_id ?? undefined,
  };
}

export async function recordPrediction(input: {
  fixtureId: string;
  prediction: string;
  postId?: string;
}): Promise<string> {
  const { data, error } = await getSupabase()
    .from('bot_predictions')
    .insert({
      fixture_id: input.fixtureId,
      prediction: input.prediction,
      post_id: input.postId ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`bot_predictions insert failed: ${error.message}`);
  return data.id as string;
}

export async function resolvePrediction(
  id: string,
  outcome: 'correct' | 'incorrect' | 'unresolved',
): Promise<void> {
  const { error } = await getSupabase()
    .from('bot_predictions')
    .update({
      outcome,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`bot_predictions resolve failed: ${error.message}`);
}

export function shouldSkipReceipt(prediction: StoredPrediction | null): boolean {
  return prediction === null;
}

export function establishedTakes(opinions: BotOpinion[]): string[] {
  return opinions.map(row => `${row.subject_name}: ${row.stance}`);
}
