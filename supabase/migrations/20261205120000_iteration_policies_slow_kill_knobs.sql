-- Slow-kill knobs for over-CPA converters (CEO Dylan, 2026-07-15).
--
-- Bianca's crown/kill decision-tree has an ABSOLUTE converter guard: `isDecisionTreeKill` returns
-- false the instant `purchases > 0`, so a converting adset can ONLY die by hitting the $1,200
-- max_test_spend deadline — no matter how bad the CAC. Live proof: Amazing Coffee test adset
-- `Dahlia · Amazing Coffee · comp` at $1,199 spend / 19 ATC / 3 sales / CAC $400 (2.7× the $150
-- crown, 1.8× the $220 profit floor) is STILL live, burning to the deadline. Its cost-per-ATC
-- ($63) is under the $80 trim line so the leading-signal trim never fires, and the converter guard
-- blocks every other early kill.
--
-- The slow-kill of over-breakeven converters was deliberately retired on 2026-07-12 (to protect a
-- $226 near-miss + keep kill_set == dud_set) but over-corrected — a converter at ANY CAC now runs
-- to $1,200. CEO 2026-07-15 rule: once an adset has spent ≥ $600, if CAC > $300 it is a dud.
--
-- This migration adds the two knobs that carry the rule (mirrors 20261018120000_crown_decision_tree_knobs.sql).
-- The rule itself lives in `tierForTest` (src/lib/ads/testing-results-sdk.ts), so agent-kill and
-- dashboard-dud never disagree (kill_set == dud_set preserved).
--
--   • slow_kill_min_spend_cents — floor at/above which an over-CPA converter is a dud. Default 60000 ($600).
--   • slow_kill_max_cpa_cents   — CAC ceiling past that spend floor. Default 30000 ($300).
--
-- Order-safe on top of the existing bands: crown needs CAC ≤ $150 and promising needs CAC ≤ $220
-- (both below $300), so slow-kill can never re-tier a crown/promising. A converter with CAC between
-- $220 and $300 stays `testing` (skeptic v3 $226 near-miss preserved).

alter table public.iteration_policies
  add column if not exists slow_kill_min_spend_cents integer not null default 60000,
  add column if not exists slow_kill_max_cpa_cents integer not null default 30000;

comment on column public.iteration_policies.slow_kill_min_spend_cents is
  'Slow-kill spend floor (cents). Past this cumulative spend, a converter with CAC > slow_kill_max_cpa_cents is a dud (kill before the $1,200 deadline). Default 60000 = $600. CEO 2026-07-15 — closes the over-CPA-converter loophole in Bianca''s decision-tree guard.';
comment on column public.iteration_policies.slow_kill_max_cpa_cents is
  'Slow-kill CAC ceiling (cents). Past slow_kill_min_spend_cents, a converter with CAC > this is a dud. Default 30000 = $300 (~2× crown target, over the $220 hold band so a promising converter is never touched; the $226-CAC skeptic v3 protection is preserved). CEO 2026-07-15.';
