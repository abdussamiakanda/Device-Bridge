-- Optional: strict retention cleanup, even when no browser is open.
-- Run after schema.sql. Requires pg_cron in your Supabase project.

create extension if not exists pg_cron with schema extensions;

create or replace function public.cleanup_device_bridge_expired()
returns void
language plpgsql
security definer
as $$
begin
  delete from storage.objects
  where bucket_id = 'device-bridge-files'
    and created_at < now() - interval '30 minutes';

  delete from public.shared_files
  where created_at < now() - interval '30 minutes';

  delete from public.clipboard_messages
  where created_at < now() - interval '30 minutes';
end;
$$;

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
