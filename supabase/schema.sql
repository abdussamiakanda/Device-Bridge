-- Run this script in Supabase SQL Editor.
-- It creates tables, indexes, realtime publication entries, and room-scoped RLS.

create extension if not exists "pgcrypto";

create table if not exists public.clipboard_messages (
  id uuid primary key default gen_random_uuid(),
  room_code_hash text not null,
  content text not null check (char_length(trim(content)) > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.shared_files (
  id uuid primary key default gen_random_uuid(),
  room_code_hash text not null,
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  file_size bigint not null,
  created_at timestamptz not null default now()
);

alter table public.clipboard_messages
  add column if not exists room_code_hash text;

alter table public.shared_files
  add column if not exists room_code_hash text;

create index if not exists clipboard_messages_created_at_idx
  on public.clipboard_messages (created_at desc);

create index if not exists clipboard_messages_room_created_idx
  on public.clipboard_messages (room_code_hash, created_at desc);

create index if not exists shared_files_created_at_idx
  on public.shared_files (created_at desc);

create index if not exists shared_files_room_created_idx
  on public.shared_files (room_code_hash, created_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'clipboard_messages'
  ) then
    alter publication supabase_realtime add table public.clipboard_messages;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shared_files'
  ) then
    alter publication supabase_realtime add table public.shared_files;
  end if;
end
$$;

alter table public.clipboard_messages enable row level security;
alter table public.shared_files enable row level security;

-- Remove existing policies to make reruns idempotent.
drop policy if exists "clipboard_messages_select_all" on public.clipboard_messages;
drop policy if exists "clipboard_messages_insert_all" on public.clipboard_messages;
drop policy if exists "clipboard_messages_delete_all" on public.clipboard_messages;

drop policy if exists "shared_files_select_all" on public.shared_files;
drop policy if exists "shared_files_insert_all" on public.shared_files;
drop policy if exists "shared_files_delete_all" on public.shared_files;

create policy "clipboard_messages_select_all"
  on public.clipboard_messages
  for select
  to anon
  using (
    room_code_hash = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );

create policy "clipboard_messages_insert_all"
  on public.clipboard_messages
  for insert
  to anon
  with check (
    room_code_hash = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );

create policy "clipboard_messages_delete_all"
  on public.clipboard_messages
  for delete
  to anon
  using (
    room_code_hash = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );

create policy "shared_files_select_all"
  on public.shared_files
  for select
  to anon
  using (
    room_code_hash = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );

create policy "shared_files_insert_all"
  on public.shared_files
  for insert
  to anon
  with check (
    room_code_hash = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );

create policy "shared_files_delete_all"
  on public.shared_files
  for delete
  to anon
  using (
    room_code_hash = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );

insert into storage.buckets (id, name, public, file_size_limit)
values ('device-bridge-files', 'device-bridge-files', false, 26214400)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- Storage: allow access to this bucket only (room isolation by path in app).
-- Drop all existing policies on storage.objects so dashboard-created ones don't block anon uploads.
do $$
declare
  r record;
begin
  for r in (select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects')
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
end $$;

create policy "storage_public_read"
  on storage.objects for select to public
  using (bucket_id = 'device-bridge-files');

create policy "storage_public_insert"
  on storage.objects for insert to public
  with check (bucket_id = 'device-bridge-files');

create policy "storage_public_delete"
  on storage.objects for delete to public
  using (bucket_id = 'device-bridge-files');

-- Explicit anon insert (some projects need this for Storage API)
create policy "storage_bridge_anon_insert"
  on storage.objects for insert to anon
  with check (bucket_id = 'device-bridge-files');

-- Single source of truth for retention (must match app RETENTION_MINUTES if you change it).
create or replace function public.retention_interval()
returns interval
language sql
stable
as $$
  select interval '30 minutes';
$$;

-- RPCs: room passed in body so access works without custom headers. All enforce strict retention.

create or replace function public.insert_clipboard_message(p_room_code_hash text, p_content text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if coalesce(trim(p_content), '') = '' then
    raise exception 'content must be non-empty';
  end if;
  insert into public.clipboard_messages (room_code_hash, content)
  values (p_room_code_hash, trim(p_content))
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.insert_clipboard_message(text, text) to anon;

create or replace function public.get_latest_clipboard_message(p_room_code_hash text)
returns table (id uuid, content text, created_at timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  select cm.id, cm.content, cm.created_at
  from public.clipboard_messages cm
  where cm.room_code_hash = p_room_code_hash
    and cm.created_at >= now() - public.retention_interval()
  order by cm.created_at desc
  limit 1;
$$;

grant execute on function public.get_latest_clipboard_message(text) to anon;

create or replace function public.insert_shared_file(
  p_room_code_hash text,
  p_file_name text,
  p_storage_path text,
  p_mime_type text,
  p_file_size bigint
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.shared_files (room_code_hash, file_name, storage_path, mime_type, file_size)
  values (p_room_code_hash, p_file_name, p_storage_path, p_mime_type, p_file_size)
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.insert_shared_file(text, text, text, text, bigint) to anon;

create or replace function public.get_shared_files(p_room_code_hash text, p_since timestamptz default null)
returns setof public.shared_files
language sql
security definer
set search_path = public
stable
as $$
  select f.*
  from public.shared_files f
  where f.room_code_hash = p_room_code_hash
    and f.created_at >= now() - public.retention_interval()
    and (p_since is null or f.created_at >= p_since)
  order by f.created_at desc;
$$;

grant execute on function public.get_shared_files(text, timestamptz) to anon;

create or replace function public.get_expired_shared_files(p_room_code_hash text)
returns table (id uuid, storage_path text)
language sql
security definer
set search_path = public
stable
as $$
  select f.id, f.storage_path
  from public.shared_files f
  where f.room_code_hash = p_room_code_hash
    and f.created_at < now() - public.retention_interval();
$$;

grant execute on function public.get_expired_shared_files(text) to anon;

create or replace function public.cleanup_expired_clipboard_messages(p_room_code_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.clipboard_messages
  where room_code_hash = p_room_code_hash
    and created_at < now() - public.retention_interval();
end;
$$;

create or replace function public.cleanup_expired_shared_files(p_room_code_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.shared_files
  where room_code_hash = p_room_code_hash
    and created_at < now() - public.retention_interval();
end;
$$;

grant execute on function public.cleanup_expired_clipboard_messages(text) to anon;
grant execute on function public.cleanup_expired_shared_files(text) to anon;

-- Used by strict-retention.sql (pg_cron) to clean up when no client is open.
create or replace function public.cleanup_device_bridge_expired()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from storage.objects
  where bucket_id = 'device-bridge-files'
    and created_at < now() - public.retention_interval();

  delete from public.shared_files
  where created_at < now() - public.retention_interval();

  delete from public.clipboard_messages
  where created_at < now() - public.retention_interval();
end;
$$;
