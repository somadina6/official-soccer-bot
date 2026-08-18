import type { CommentaryStyle, ContentIntent } from '../domain/content.js';
import { logger } from '../observability/logger.js';
import { getSupabase } from '../supabase/client.js';

export const CONTENT_JOB_STATUSES = [
  'pending',
  'processing',
  'completed',
  'skipped',
  'failed',
] as const;
export type ContentJobStatus = (typeof CONTENT_JOB_STATUSES)[number];

export type ContentJob = {
  id: string;
  intent: Exclude<ContentIntent, 'live_reaction'>;
  source_id: string | null;
  payload: Record<string, unknown>;
  status: ContentJobStatus;
  scheduled_for: string;
  style: CommentaryStyle | null;
};

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function subtractMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() - minutes * 60_000);
}

export type EnqueueContentJobInput = {
  intent: Exclude<ContentIntent, 'live_reaction'>;
  sourceId: string;
  scheduledFor: Date;
  payload: Record<string, unknown>;
};

/**
 * Idempotent schedule: one pending/processing row per (intent, source).
 * Kickoff changes update `scheduled_for` on the existing row.
 */
export async function enqueueContentJob(input: EnqueueContentJobInput): Promise<string> {
  const supabase = getSupabase();
  const { data: existing, error: lookupError } = await supabase
    .from('content_jobs')
    .select('id, scheduled_for, status')
    .eq('intent', input.intent)
    .eq('source_id', input.sourceId)
    .in('status', ['pending', 'processing', 'completed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupError) throw new Error(`content_jobs lookup failed: ${lookupError.message}`);

  if (existing) {
    if (existing.status === 'completed') return existing.id as string;
    if (existing.scheduled_for !== input.scheduledFor.toISOString()) {
      const { error: updateError } = await supabase
        .from('content_jobs')
        .update({ scheduled_for: input.scheduledFor.toISOString() })
        .eq('id', existing.id);
      if (updateError) throw new Error(`content_jobs reschedule failed: ${updateError.message}`);
    }
    return existing.id as string;
  }

  const { data, error } = await supabase
    .from('content_jobs')
    .insert({
      intent: input.intent,
      source_id: input.sourceId,
      payload: input.payload,
      scheduled_for: input.scheduledFor.toISOString(),
      status: 'pending',
    })
    .select('id')
    .single();
  if (error) throw new Error(`content_jobs insert failed: ${error.message}`);
  return data.id as string;
}

export async function loadContentJob(id: string): Promise<ContentJob> {
  const { data, error } = await getSupabase()
    .from('content_jobs')
    .select('id, intent, source_id, payload, status, scheduled_for, style')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`content_job ${id} not found: ${error?.message}`);
  return data as ContentJob;
}

export async function saveSelectedStyle(jobId: string, style: CommentaryStyle): Promise<void> {
  const { error } = await getSupabase()
    .from('content_jobs')
    .update({ style })
    .eq('id', jobId);
  if (error) throw new Error(`saveSelectedStyle failed: ${error.message}`);
}

export async function markJobStatus(
  jobId: string,
  status: ContentJobStatus,
  scheduledFor?: Date,
): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (scheduledFor) patch.scheduled_for = scheduledFor.toISOString();
  const { error } = await getSupabase().from('content_jobs').update(patch).eq('id', jobId);
  if (error) throw new Error(`markJobStatus failed: ${error.message}`);
}

export async function skipPendingJobs(sourceId: string, reason: string): Promise<void> {
  const { error } = await getSupabase()
    .from('content_jobs')
    .update({ status: 'skipped' })
    .eq('source_id', sourceId)
    .eq('status', 'pending');
  if (error) throw new Error(`skipPendingJobs failed: ${error.message}`);
  logger.info({ sourceId, reason }, 'pending content jobs skipped');
}

export type ScheduleableFixture = {
  id: number;
  starts_at: string;
  status: string;
};

/**
 * Schedules prediction (−45m) and post-match verdict (+125m) plus a receipt
 * (+130m). Late predictions are omitted. Kickoff moves update pending times.
 */
export async function scheduleMatchContent(fixture: ScheduleableFixture): Promise<void> {
  const sourceId = String(fixture.id);
  const kickoff = new Date(fixture.starts_at);
  const now = new Date();

  if (fixture.status === 'postponed' || fixture.status === 'cancelled') {
    await skipPendingJobs(sourceId, fixture.status);
    return;
  }

  const payload = { fixtureId: fixture.id };

  if (fixture.status === 'scheduled' || fixture.status === 'live') {
    const predictionAt = subtractMinutes(kickoff, 45);
    if (predictionAt.getTime() > now.getTime() && fixture.status === 'scheduled') {
      await enqueueContentJob({
        intent: 'prediction',
        sourceId,
        scheduledFor: predictionAt,
        payload,
      });
    }
  }

  if (fixture.status !== 'finished') {
    const verdictAt = addMinutes(kickoff, 125);
    await enqueueContentJob({
      intent: 'post_match_verdict',
      sourceId,
      scheduledFor: verdictAt.getTime() > now.getTime() ? verdictAt : now,
      payload,
    });
    await enqueueContentJob({
      intent: 'receipt',
      sourceId,
      scheduledFor: addMinutes(kickoff, 130).getTime() > now.getTime()
        ? addMinutes(kickoff, 130)
        : now,
      payload,
    });
    return;
  }

  await enqueueContentJob({
    intent: 'post_match_verdict',
    sourceId,
    scheduledFor: now,
    payload,
  });
  await enqueueContentJob({
    intent: 'receipt',
    sourceId,
    scheduledFor: now,
    payload,
  });
}

export async function listDueContentJobs(limit = 20): Promise<ContentJob[]> {
  const { data, error } = await getSupabase()
    .from('content_jobs')
    .select('id, intent, source_id, payload, status, scheduled_for, style')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listDueContentJobs failed: ${error.message}`);
  return (data ?? []) as ContentJob[];
}
