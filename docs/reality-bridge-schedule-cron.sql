-- Reality Bridge scheduled rules: enqueue a server scan every minute for accounts
-- that have at least one scheduled rule synced to push_bridge_config.
-- Requires the existing push-jobs-scan cron job, which dispatches kind=bridge_scan
-- jobs to the push-bridge Edge Function. Run once in the user's own Supabase SQL Editor.
-- Idempotent: cron.schedule replaces a job with the same name, and trigger_key is unique
-- per account and minute so repeated cron invocations do not enqueue duplicates.

create extension if not exists pg_cron;

select cron.unschedule('reality-bridge-schedule-scan')
where exists (
  select 1 from cron.job where jobname = 'reality-bridge-schedule-scan'
);

select cron.schedule(
  'reality-bridge-schedule-scan',
  '* * * * *',
  $CRON$
    insert into public.push_jobs
      (id, user_id, trigger_key, kind, execute_at, status, payload)
    select
      'job_' || gen_random_uuid()::text,
      c.user_id,
      'bridge:schedule:' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI'),
      'bridge_scan',
      now(),
      'pending',
      jsonb_build_object('kind', 'bridge_schedule_scan')
    from public.push_bridge_config c
    where exists (
      select 1
      from jsonb_array_elements(coalesce(c.rules, '[]'::jsonb)) as rule(value)
      where rule.value ? 'schedule'
        and rule.value->'schedule' is not null
        and rule.value->'schedule' <> 'null'::jsonb
    )
    on conflict (user_id, trigger_key) do nothing;
  $CRON$
);
