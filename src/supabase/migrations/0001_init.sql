-- Premier League AI commentary bot — core schema.
-- All tables are private to the worker (service role); RLS is enabled with no
-- anon/authenticated policies so the Data API exposes nothing by default.

create table if not exists competitions (
  id bigint generated always as identity primary key,
  slug text not null unique,
  provider text not null,
  provider_tournament_id bigint,
  expected_name text not null,
  expected_country text not null,
  verified_at timestamptz
);

create table if not exists fixtures (
  id bigint generated always as identity primary key,
  provider text not null,
  provider_match_id bigint not null,
  competition_id bigint not null references competitions(id),
  starts_at timestamptz not null,
  status text not null default 'scheduled',
  home_team jsonb not null,
  away_team jsonb not null,
  prepared_backgrounds jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_match_id)
);

create index if not exists fixtures_starts_at_idx on fixtures (starts_at);
create index if not exists fixtures_status_idx on fixtures (status);

-- One row per normalized provider incident revision. The idempotency key is
-- the deduplication backbone for the whole pipeline.
create table if not exists match_events (
  id bigint generated always as identity primary key,
  idempotency_key text not null unique,
  fixture_id bigint not null references fixtures(id),
  provider text not null,
  provider_match_id bigint not null,
  provider_incident_id text,
  event_type text not null,
  state text not null default 'RECEIVED',
  minute int not null,
  stoppage_minute int,
  occurred_at timestamptz not null,
  normalized jsonb not null,
  raw_payload jsonb not null,
  raw_payload_hash text not null,
  revision int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists match_events_state_idx on match_events (state);
create index if not exists match_events_match_idx on match_events (provider_match_id);

create table if not exists event_revisions (
  id bigint generated always as identity primary key,
  match_event_id bigint not null references match_events(id),
  revision int not null,
  raw_payload jsonb not null,
  raw_payload_hash text not null,
  created_at timestamptz not null default now(),
  unique (match_event_id, revision)
);

create table if not exists content_generations (
  id bigint generated always as identity primary key,
  match_event_id bigint not null references match_events(id),
  attempt int not null default 1,
  model text not null,
  post_text text not null,
  image_prompt text not null,
  alt_text text not null,
  referenced_facts jsonb not null default '[]'::jsonb,
  risk text not null,
  validation_passed boolean not null default false,
  validation_errors jsonb not null default '[]'::jsonb,
  used_fallback_template boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists media_assets (
  id bigint generated always as identity primary key,
  match_event_id bigint references match_events(id),
  fixture_id bigint references fixtures(id),
  kind text not null, -- 'prepared_background' | 'final_composite'
  storage_path text,
  image_hash text not null,
  x_media_id text,
  alt_text text,
  created_at timestamptz not null default now()
);

create index if not exists media_assets_hash_idx on media_assets (image_hash);

create table if not exists published_posts (
  id bigint generated always as identity primary key,
  match_event_id bigint not null references match_events(id),
  idempotency_key text not null unique,
  x_post_id text not null,
  post_text text not null,
  x_media_id text,
  correlation_id text,
  in_reply_to_post_id text,
  is_correction boolean not null default false,
  cost_estimate_usd numeric(10, 5),
  published_at timestamptz not null default now()
);

create table if not exists job_failures (
  id bigint generated always as identity primary key,
  queue_name text not null,
  message jsonb not null,
  error text not null,
  attempts int not null,
  created_at timestamptz not null default now()
);

create table if not exists account_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Admin controls (section 3): pause switch, dry-run, tone, per-event toggles,
-- manual approval mode. The worker reads these on every publish decision.
insert into account_settings (key, value) values
  ('publishing_enabled', 'false'::jsonb),
  ('dry_run', 'true'::jsonb),
  ('manual_approval', 'false'::jsonb),
  ('banter_tone', '"playful"'::jsonb),
  ('enabled_event_types', '["GOAL","OWN_GOAL","RED_CARD","PENALTY_MISSED","VAR","FULL_TIME"]'::jsonb)
on conflict (key) do nothing;

-- Seed stable expectations only; the provider tournament ID is discovered
-- dynamically and confirmed manually (section 4).
insert into competitions (slug, provider, expected_name, expected_country)
values ('premier-league', 'sportsapi-pro', 'Premier League', 'England')
on conflict (slug) do nothing;

-- Row Level Security: enabled everywhere, no policies for anon/authenticated.
-- The Railway worker connects with the service role, which bypasses RLS.
alter table competitions enable row level security;
alter table fixtures enable row level security;
alter table match_events enable row level security;
alter table event_revisions enable row level security;
alter table content_generations enable row level security;
alter table media_assets enable row level security;
alter table published_posts enable row level security;
alter table job_failures enable row level security;
alter table account_settings enable row level security;
