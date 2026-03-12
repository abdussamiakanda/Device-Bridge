-- Optional: run cleanup on a schedule when no browser is open.
-- Run after schema.sql. Requires pg_cron in your Supabase project.
-- Uses public.cleanup_device_bridge_expired() and public.retention_interval() from schema.sql.

create extension if not exists pg_cron with schema extensions;

do $$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
  from cron.job
  where jobname = 'device_bridge_cleanup'
  limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'device_bridge_cleanup',
    '*/5 * * * *',
    'select public.cleanup_device_bridge_expired();'
  );
end
$$;
