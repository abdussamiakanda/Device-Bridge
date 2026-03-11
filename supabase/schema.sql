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

drop policy if exists "storage_public_read" on storage.objects;
drop policy if exists "storage_public_insert" on storage.objects;
drop policy if exists "storage_public_delete" on storage.objects;

create policy "storage_public_read"
  on storage.objects
  for select
  to anon
  using (
    bucket_id = 'device-bridge-files'
    and split_part(name, '/', 1) = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );

create policy "storage_public_insert"
  on storage.objects
  for insert
  to anon
  with check (
    bucket_id = 'device-bridge-files'
    and split_part(name, '/', 1) = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );

create policy "storage_public_delete"
  on storage.objects
  for delete
  to anon
  using (
    bucket_id = 'device-bridge-files'
    and split_part(name, '/', 1) = coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-room-code-hash',
      ''
    )
  );
