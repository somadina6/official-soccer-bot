-- Supabase Queues (pgmq). Requires the Queues integration to be enabled on the
-- project first (Dashboard → Integrations → Queues), which installs pgmq.
-- These are logged Basic Queues (pgmq.create), not unlogged queues.

create extension if not exists pgmq;

select pgmq.create('event-confirmation');
select pgmq.create('content-generation');
select pgmq.create('image-generation');
select pgmq.create('x-publishing');
select pgmq.create('post-corrections');
select pgmq.create('dead-letter');

-- Queues stay private to Postgres: we deliberately do NOT expose pgmq_public
-- through the Data API. The worker consumes them over a direct server-side
-- Postgres connection with the service role.
