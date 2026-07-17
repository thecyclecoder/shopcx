-- ad_campaigns.author_self_score — Dahlia copy-author box session self-score
-- (docs/brain/specs/dahlia-copy-author-box-session.md Phase 2 — folded into the Phase 3 wire-in
-- because the goal branch never independently shipped Phase 2 first; the AuthorModeCopy payload
-- Phase 3 threads through insertReadyCreative has nowhere to persist the self-score without this
-- column).
--
-- Dahlia's per-creative Max box session (kind='ad-creative-copy-author') emits a self-score
-- against the shared 0-10 Conversion-Psychology rubric (LF8 + Schwartz + Cialdini + Hopkins +
-- Sugarman) alongside the finished caption. The score is stamped here so the M1 Max QC spec and
-- Bianca's M3 measurement spec have somewhere to read from — a nullable jsonb keeps the
-- deterministic buildMetaCopyPack path byte-identical (null-means-deterministic-mode).
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS, no backfill, no default, no index — the
-- column is per-row at insert-time only, not a query filter).
alter table public.ad_campaigns
  add column if not exists author_self_score jsonb;

comment on column public.ad_campaigns.author_self_score is
  'Dahlia author-mode self-score against the shared 0-10 Conversion-Psychology rubric. Shape: { lf8:int, schwartz:int, cialdini:int, hopkins:int, sugarman:int, total:int, evidence:string[] }. Stamped by insertReadyCreative in src/lib/ads/creative-agent.ts when DAHLIA_COPY_MODE=author dispatched a copy-author box session that returned an ok verdict; NULL for deterministic buildMetaCopyPack inserts and pre-Dahlia rows.';
