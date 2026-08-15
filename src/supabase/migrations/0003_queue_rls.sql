-- Enable RLS on every pgmq queue/archive table so PostgREST will not
-- expose them anonymously. No policies are added: anon and authenticated
-- see nothing. The worker uses the secret key (service_role), which
-- bypasses RLS.
--
-- https://supabase.com/docs/guides/queues/quickstart

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
