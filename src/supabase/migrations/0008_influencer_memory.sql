-- MatchMouth influencer memory, scheduled content jobs, and a text-only
-- publish path that is not tied to a live match_event.

create table if not exists bot_opinions (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_name text not null,
  stance text not null,
  evidence jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bot_opinions_subject_idx
  on bot_opinions (subject_type, subject_name)
  where status = 'active';

create table if not exists bot_predictions (
  id uuid primary key default gen_random_uuid(),
  fixture_id text not null,
  prediction text not null,
  post_id text,
  outcome text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists bot_predictions_fixture_idx
  on bot_predictions (fixture_id);

create table if not exists content_jobs (
  id uuid primary key default gen_random_uuid(),
  intent text not null,
  source_id text,
  payload jsonb not null,
  status text not null default 'pending',
  scheduled_for timestamptz not null,
  style text,
  created_at timestamptz not null default now()
);

create unique index if not exists content_jobs_pending_intent_source_idx
  on content_jobs (intent, source_id)
  where status in ('pending', 'processing');

create index if not exists content_jobs_due_idx
  on content_jobs (scheduled_for)
  where status = 'pending';

alter table published_posts
  alter column match_event_id drop not null;

alter table published_posts
  add column if not exists content_job_id uuid references content_jobs(id),
  add column if not exists intent text;

alter table content_generations
  alter column match_event_id drop not null;

alter table content_generations
  add column if not exists content_job_id uuid references content_jobs(id),
  add column if not exists intent text,
  add column if not exists opinion_claims jsonb not null default '[]'::jsonb,
  add column if not exists style text;

select pgmq.create('influencer-content');

alter table bot_opinions enable row level security;
alter table bot_predictions enable row level security;
alter table content_jobs enable row level security;

do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename
    from pg_tables
    where schemaname = 'pgmq'
      and (tablename like 'q_%' or tablename like 'a_%')
  loop
    execute format(
      'alter table %I.%I enable row level security',
      r.schemaname,
      r.tablename
    );
  end loop;
end $$;
