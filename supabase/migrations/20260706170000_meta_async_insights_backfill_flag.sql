-- Per-account flag gating Meta's async-report insights backfill path
-- (docs/brain/specs/iteration-ingest-async-reports.md, Phase 1).
--
-- The iteration engine's first-run insights backfill normally uses ≤14-day chunked
-- SYNCHRONOUS GETs (iteration-engine-ingest-resilience P2). For a brand-new account
-- backfilling *years* of history, even those chunked GETs can strain Meta (transient
-- code 2 "Service temporarily unavailable" / GET rate-limiting). This flag, when on,
-- routes the FIRST-RUN BACKFILL WINDOW through Meta's sanctioned async report path
-- (POST /act_{id}/insights → report_run_id → poll → page). The daily incremental
-- window always keeps the light synchronous GET. Default false: the path ships dark
-- and is flipped on only where the large-backfill pain is real.
--
-- Read defensively by isAsyncBackfillEnabled() in src/lib/meta/performance.ts — a
-- missing column simply means "disabled", so the code is safe to ship before/after
-- this migration applies.

ALTER TABLE public.meta_ad_accounts
  ADD COLUMN IF NOT EXISTS async_insights_backfill_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.meta_ad_accounts.async_insights_backfill_enabled IS
  'When true, the first-run insights backfill uses Meta''s async report path '
  '(submit/poll/page) instead of chunked synchronous GETs. Daily incremental always '
  'uses sync GET. See docs/brain/specs/iteration-ingest-async-reports.md.';
