import { getSupabase } from '../supabase/client.js';
import { IMAGE_PROMPT_VERSION } from './prompt-builder.js';

/**
 * `media_assets` rows with kind = 'generated_event' double as the image-job
 * ledger (migration 0005). One row per (match_event_id, prompt_version); the
 * partial unique index makes the claim insert atomic.
 */

export type ImageJobStatus =
  | 'pending'
  | 'generating'
  | 'compositing'
  | 'stored'
  | 'uploaded_to_x'
  | 'fallback_used'
  | 'failed';

export type ImageJob = {
  id: number;
  match_event_id: number;
  fixture_id: number | null;
  status: ImageJobStatus;
  prompt_version: string;
  storage_path: string | null;
  image_hash: string | null;
  byte_length: number | null;
  generation_attempts: number;
  generation_duration_ms: number | null;
  used_fallback: boolean;
  x_media_id: string | null;
  x_media_expires_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

const JOB_COLUMNS =
  'id, match_event_id, fixture_id, status, prompt_version, storage_path, image_hash, ' +
  'byte_length, generation_attempts, generation_duration_ms, used_fallback, ' +
  'x_media_id, x_media_expires_at, last_error_code, last_error_message';

/** States in which a finished JPEG exists at `storage_path`. */
export const IMAGE_READY_STATUSES: ImageJobStatus[] = ['stored', 'uploaded_to_x', 'fallback_used'];

/**
 * States in which the image job is finished trying, whether or not it
 * produced a JPEG. 'failed' means generation gave up with no fallback: the
 * event publishes to X as text-only rather than waiting forever.
 */
export const IMAGE_DONE_STATUSES: ImageJobStatus[] = [...IMAGE_READY_STATUSES, 'failed'];

export async function findImageJob(matchEventId: number): Promise<ImageJob | null> {
  const { data, error } = await getSupabase()
    .from('media_assets')
    .select(JOB_COLUMNS)
    .eq('match_event_id', matchEventId)
    .eq('kind', 'generated_event')
    .eq('prompt_version', IMAGE_PROMPT_VERSION)
    .maybeSingle();
  if (error) throw new Error(`image job lookup failed: ${error.message}`);
  return (data as ImageJob | null) ?? null;
}

/**
 * Atomic claim: insert wins the job; a 23505 on the partial unique index
 * means another worker already owns it, so the existing row is returned.
 */
export async function claimImageJob(
  matchEventId: number,
  fixtureId: number,
): Promise<{ job: ImageJob; claimed: boolean }> {
  const { data, error } = await getSupabase()
    .from('media_assets')
    .insert({
      match_event_id: matchEventId,
      fixture_id: fixtureId,
      kind: 'generated_event',
      prompt_version: IMAGE_PROMPT_VERSION,
      status: 'pending',
    })
    .select(JOB_COLUMNS)
    .single();

  if (!error) return { job: data as unknown as ImageJob, claimed: true };
  if (error.code !== '23505') throw new Error(`image job claim failed: ${error.message}`);

  const existing = await findImageJob(matchEventId);
  if (!existing) throw new Error(`image job for event ${matchEventId} vanished after 23505`);
  return { job: existing, claimed: false };
}

export async function updateImageJob(
  jobId: number,
  patch: Partial<Omit<ImageJob, 'id' | 'match_event_id' | 'fixture_id' | 'prompt_version'>>,
): Promise<void> {
  const { error } = await getSupabase().from('media_assets').update(patch).eq('id', jobId);
  if (error) throw new Error(`image job update failed: ${error.message}`);
}

export async function markGenerating(job: ImageJob): Promise<void> {
  await updateImageJob(job.id, {
    status: 'generating',
    generation_attempts: job.generation_attempts + 1,
  });
}
