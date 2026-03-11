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
3. If you already ran an older schema, rerun this updated schema to apply room-code columns and policies.

This creates:

- `public.clipboard_messages`
- `public.shared_files`
- realtime publication entries for both tables
- private storage bucket `device-bridge-files`
- room-scoped anon policies using `x-room-code-hash`

## 3) Run the app

```bash
npm install
npm run dev
```

Open the page on both devices, enter the same secret code, and start sharing.

## Retention notes

- UI only reads data newer than 30 minutes.
- The app runs cleanup every 2 minutes (deletes expired DB rows and storage files in the same room).
- For strict retention when no client is open, also run `supabase/strict-retention.sql`.

## Security notes

- The app hashes your secret with SHA-256 in the browser and sends only the hash.
- Data access is room-scoped via RLS policies using the room hash header.
- Anyone who knows the exact secret can access that room, so use a long random secret.
