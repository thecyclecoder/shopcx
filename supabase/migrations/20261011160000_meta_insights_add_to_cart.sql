-- Add Meta's reported ADD-TO-CART count to per-object insights (CEO 2026-07-10). Cost-per-ATC (spend ÷
-- add_to_cart) is the strongest LEADING laggard signal — it flags a dud before purchases accumulate
-- (validated on Amazing Coffee: winners $18–65/ATC, laggards $100–152/ATC; CTR alone lies — a 9.8%-CTR
-- ad had $152/ATC + $1,216 CPP). Populated by src/lib/meta/performance.ts from actions[add_to_cart].
alter table public.meta_insights_daily
  add column if not exists add_to_cart int not null default 0;

comment on column public.meta_insights_daily.add_to_cart is
  'Meta-reported add-to-cart count (actions[add_to_cart]/omni/pixel). Cost-per-ATC = spend_cents/add_to_cart — the leading early-trim signal for the media buyer.';

-- The media buyer's LEADING early-trim thresholds (replaces the lagging cost-per-purchase trim).
alter table public.iteration_policies
  -- Trim a laggard when cost-per-ATC (spend ÷ add_to_cart) exceeds this (cents) — the primary signal.
  add column if not exists trim_max_cost_per_atc_cents bigint,
  -- ...or when CPM (spend per 1000 impressions) exceeds this (cents) — Meta disfavoring the ad.
  add column if not exists trim_max_cpm_cents bigint;

comment on column public.iteration_policies.trim_max_cost_per_atc_cents is
  'Media-buyer early trim: kill a laggard whose cost-per-ATC (spend/add_to_cart) exceeds this (cents). Leading signal.';
comment on column public.iteration_policies.trim_max_cpm_cents is
  'Media-buyer early trim: kill a laggard whose CPM (spend per 1000 impressions) exceeds this (cents).';
