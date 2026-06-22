-- Error-Feed Monitoring — Phase 1 (see docs/brain/specs/error-feed-monitoring.md).
--
-- One table holding GROUPED error incidents from the three "hidden surfaces"
-- the Control Tower dashboard never showed:
--   source='inngest'  — an Inngest function that failed after exhausting retries
--                       (captured by the inngest/function.failed handler).
--   source='vercel'   — a prod runtime error / 500, delivered by a Vercel Log Drain
--                       to /api/webhooks/vercel-logs.
--   source='supabase' — a non-null Supabase { error } our own code saw and reported
--                       via reportDbError() (the swallowed-error class, at the source).
--
-- Errors are GROUPED by (source, signature): a burst of the same error is ONE
-- incident with a bumped `count` + `last_seen_at`, not N rows / N pages. A new
-- signature (or a spike that re-fires past the page cooldown) pages the owners
-- via the Slack ops path, rate-limited by `last_paged_at`.
--
-- GLOBAL infra (not workspace-scoped), exactly like loop_heartbeats / loop_alerts:
-- the box + crons + the prod app are one shared fleet. RLS: any authenticated
-- user reads; service role does all writes (Inngest + the webhook + app code).

create table if not exists public.error_events (
  id uuid primary key default gen_random_uuid(),
  -- 'inngest' | 'vercel' | 'supabase' — which hidden surface this came from.
  source text not null check (source in ('inngest', 'vercel', 'supabase')),
  -- the grouping key: a stable hash of the normalized error (digits/uuids/hex
  -- stripped) so the same error recurring lands on the same incident row.
  signature text not null,
  -- short human-readable label for the panel (e.g. the function id + error class).
  title text not null,
  -- the fuller / latest detail (the most recent message seen for this signature).
  detail text,
  -- the latest raw sample for this signature (function_id, run_id, path, code, …).
  sample jsonb,
  -- total occurrences folded into this incident.
  count int not null default 1,
  status text not null default 'open' check (status in ('open', 'resolved')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- when we last paged the owners about this incident (rate-limit spine).
  last_paged_at timestamptz,
  created_at timestamptz not null default now()
);

-- One incident per (source, signature) — the grouping spine. recordError() upserts
-- against this: insert+page on a new signature, else bump count/last_seen_at.
create unique index if not exists error_events_source_signature
  on public.error_events (source, signature);
-- Panel queries read newest-first per source.
create index if not exists error_events_source_last_seen_idx
  on public.error_events (source, last_seen_at desc);

alter table public.error_events enable row level security;
drop policy if exists error_events_select on public.error_events;
create policy error_events_select on public.error_events
  for select to authenticated using (auth.uid() is not null);
drop policy if exists error_events_service on public.error_events;
create policy error_events_service on public.error_events
  for all to service_role using (true) with check (true);
