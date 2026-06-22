-- Error-Feed Monitoring — Phase 2: Supabase Management Logs API
-- (see docs/brain/specs/error-feed-monitoring.md).
--
-- The fourth "hidden surface": DB-LEVEL Supabase errors our own app code never
-- sees — Postgres ERROR/FATAL/PANIC, auth-service errors, and API 5xxs behind
-- the edge — pulled from the Supabase **Management Logs API** (logs.all SQL) on
-- a poll. Recorded into the SAME grouped error_events store as Phase 1 under a
-- NEW source 'supabase-logs', so the dashboard shows it as its own panel
-- ("Supabase errors (DB logs)") distinct from the app-layer 'supabase' reporter.
--
-- Two changes:
--   1. Widen the error_events.source CHECK to admit 'supabase-logs'.
--   2. A single-row config table holding the owner's Supabase access token
--      (encrypted, AES-256-GCM via src/lib/crypto.ts) + the poll cursor. The
--      token is the LONE owner setup for this spec (the service-role key we have
--      is for data, not logs) — pasted once via the owner-only API. Service-role
--      only: it holds a secret, so no authenticated SELECT (the dashboard learns
--      "configured?" through the owner API, server-side, never the raw token).

-- 1) Widen the source enum to include the Management-Logs feed.
alter table public.error_events drop constraint if exists error_events_source_check;
alter table public.error_events
  add constraint error_events_source_check
  check (source in ('inngest', 'vercel', 'supabase', 'supabase-logs'));

-- 2) The poller's encrypted token + cursor (single global row, id='singleton').
create table if not exists public.error_feed_supabase_config (
  id text primary key default 'singleton' check (id = 'singleton'),
  -- the owner's Supabase access token (personal/management), AES-256-GCM ciphertext
  -- (iv:tag:ciphertext hex) via src/lib/crypto.ts. Null until the owner pastes it.
  access_token_encrypted text,
  -- the project ref (the <ref> in https://<ref>.supabase.co). Defaults to the ref
  -- parsed from NEXT_PUBLIC_SUPABASE_URL at poll time; stored only if overridden.
  project_ref text,
  -- poll cursor: the high-water timestamp of the last successful poll. The next
  -- poll asks the Logs API for the window (last_polled_at, now], capped to 24h.
  last_polled_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Service-role only — the row holds a secret. No authenticated SELECT policy
-- (unlike error_events, which any authenticated user may read).
alter table public.error_feed_supabase_config enable row level security;
drop policy if exists error_feed_supabase_config_service on public.error_feed_supabase_config;
create policy error_feed_supabase_config_service on public.error_feed_supabase_config
  for all to service_role using (true) with check (true);
