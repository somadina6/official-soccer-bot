-- Per-event GPT image flow: media_assets doubles as the image-job ledger.
-- A row with kind = 'generated_event' tracks one per-event generated JPEG
-- through its lifecycle (claim -> generate -> store -> upload to X).

alter table media_assets
  add column if not exists prompt_version text,
  add column if not exists status text not null default 'pending',
  add column if not exists generation_attempts int not null default 0,
  add column if not exists generation_duration_ms int,
  add column if not exists used_fallback boolean not null default false,
  add column if not exists byte_length int,
  add column if not exists x_media_expires_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_error_message text;

-- The claim insert happens before any image exists, so the hash can no longer
-- be mandatory at insert time.
alter table media_assets alter column image_hash drop not null;

alter table media_assets drop constraint if exists media_assets_status_check;
alter table media_assets
  add constraint media_assets_status_check check (status in (
    'pending',
    'generating',
    'compositing',
    'stored',
    'uploaded_to_x',
    'fallback_used',
    'failed'
  ));

-- Atomic claim: exactly one generated-event image job per event and prompt
-- version. A second worker inserting the same key hits 23505 and backs off.
create unique index if not exists media_assets_generated_event_unique
  on media_assets (match_event_id, prompt_version)
  where kind = 'generated_event';

create index if not exists media_assets_event_kind_idx
  on media_assets (match_event_id, kind);
