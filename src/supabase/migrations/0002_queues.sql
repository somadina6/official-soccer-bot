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

-- The worker uses pgmq_public RPCs (send/read/archive/delete) with the
-- secret key. Do not grant pgmq_public to anon or authenticated.
