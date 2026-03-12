# Device Bridge

Realtime text + file bridge for moving data between devices.

## What it does

- Syncs text instantly across all open tabs/devices.
- Uploads files and lets other devices download from the same page.
- Requires the same secret code on both devices to access the same room.
- Hides expired data after 30 minutes.
- Removes expired records/files while any client is open.

## Stack

- React + Vite
- CSS
- Supabase (Postgres, Realtime, Storage)

## 1) Local env setup

1. Copy `.env.example` to `.env`.
2. Fill values:

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
VITE_SUPABASE_FILES_BUCKET=device-bridge-files
```

## 2) Supabase setup

1. Open Supabase SQL Editor.
2. Run `supabase/schema.sql`.

This creates:

- `public.clipboard_messages` and `public.shared_files`
- Realtime publication entries for both tables
- Private storage bucket `device-bridge-files`
- **Strict retention**: `public.retention_interval()` (30 minutes). All RPCs only return/affect rows within this window.
- RPCs used by the app: `insert_clipboard_message`, `get_latest_clipboard_message`, `insert_shared_file`, `get_shared_files`, `get_expired_shared_files`, `cleanup_expired_clipboard_messages`, `cleanup_expired_shared_files`, and `cleanup_device_bridge_expired` (for optional cron).

## 3) Run the app

```bash
npm install
npm run dev
```

Open the page on both devices, enter the same secret code, and start sharing.

## Retention notes

- Retention is **30 minutes**, defined in the DB by `public.retention_interval()`. RPCs only return or delete rows within that window.
- The app runs cleanup every 2 minutes (deletes expired DB rows and storage files in the same room).
- For cleanup when no client is open, run `supabase/strict-retention.sql` (schedules pg_cron to call `cleanup_device_bridge_expired()` every 5 minutes).

## Troubleshooting

- **Storage 400 / "new row violates row-level security policy"**  
  Re-run `supabase/schema.sql` in the SQL Editor so the storage policies are applied. If it still fails, in the Dashboard go to **Storage → Policies** and remove any other policies on `storage.objects` that might block anon, then run the schema again.

## Security notes

- The app hashes your secret with SHA-256 in the browser and sends only the hash.
- Data access is room-scoped via RPCs (room hash passed in the request body).
- Anyone who knows the exact secret can access that room, so use a long random secret.
