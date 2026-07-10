-- Media-buyer "trust Meta's reported signal" — the CEO decision (2026-07-10) that for Meta-based
-- media buying we trust Meta's own reported conversions/CPA rather than our internal order-match
-- (which structurally can't resolve Shopify-destined ad revenue). Adds the CPA-based crown/trim knobs
-- + the trust flag to iteration_policies. See docs/brain/lifecycles/media-buyer + tables/iteration_policies.
alter table public.iteration_policies
  -- When true: the media-buyer runtime detects winners on Meta's REPORTED CPA (spend ÷ purchases from
  -- meta_insights_daily via iteration_scorecards_daily) instead of internal-resolve ROAS, and the
  -- sensor-trust gate trusts Meta (gates on Meta-signal freshness, not internal-resolve coverage).
  add column if not exists trust_meta_reported_signal boolean not null default false,
  -- Crown a winner only when its Meta-reported CPA is at/below this (cents). NULL = fall back to the
  -- ROAS-floor path. e.g. 15000 = $150 CPA.
  add column if not exists crown_max_cpa_cents bigint,
  -- ...AND it has at least this much Meta spend (cents) — the verdict floor. e.g. 45000 = $450.
  add column if not exists crown_min_spend_cents bigint,
  -- Trim a loser EARLY (before the crown floor) once it has at least this much spend (cents) with a
  -- clearly-bad CPA. e.g. 20000 = $200. NULL = fall back to pause_min_spend_cents.
  add column if not exists early_trim_min_spend_cents bigint;

comment on column public.iteration_policies.trust_meta_reported_signal is
  'Media-buyer: trust Meta reported CPA signal (meta_insights_daily) over internal-resolve ROAS for winner/loser detection + the trust gate. CEO 2026-07-10.';
comment on column public.iteration_policies.crown_max_cpa_cents is
  'Media-buyer: crown a winner only at Meta-reported CPA (spend/purchases) <= this (cents), with spend >= crown_min_spend_cents.';
comment on column public.iteration_policies.crown_min_spend_cents is
  'Media-buyer: min Meta spend (cents) before a winner can be crowned — the verdict floor (e.g. 45000 = $450).';
comment on column public.iteration_policies.early_trim_min_spend_cents is
  'Media-buyer: min spend (cents) before an early CPA-based trim of a clear loser (e.g. 20000 = $200).';
