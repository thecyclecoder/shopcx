-- Dynamic, time-boxed persist-to-renewal offer model — the offer *model* (P1) for
-- docs/brain/specs/storefront-dynamic-renewal-offers.md (M6 of the storefront-optimizer
-- goal). pricing_rules is static-per-product (one rule joined via product_pricing_rule,
-- read live by resolveSubscriptionPricing). This adds a CHILD table that expresses a
-- scoped, time-boxed offer whose discount PERSISTS TO RENEWAL — not just first order.
--
-- North-star split: a first-order coupon stays on the autonomous coupons path; an offer
-- that persists to renewal bleeds margin on every renewal, so it is ALWAYS owner-approved
-- (status proposed → approved → active → expired) and is NEVER autonomous. This spec ships
-- the MODEL ONLY — the offer-activation LEVER + its margin-floor / expiry / rollback
-- guardrails are deferred to docs/brain/specs/storefront-renewal-offer-lever.md.
--
-- Mechanism (mirrors the engine's "references, not baked prices" philosophy): a sub records
-- WHICH offer it was acquired under via subscriptions.pricing_offer_id (a reference, not a
-- baked price). The renewal engine reads that reference; if the offer is still `active` and
-- inside its [starts_at, ends_at] window, it applies the delta — so the offer persists to
-- renewal and is cleanly reversible (expire the offer / null the column → base pricing).
--
-- Safety invariants baked in here:
--   • status CHECK ∈ proposed|approved|active|expired
--   • lander_type CHECK ∈ pdp|listicle|beforeafter|advertorial (mirrors storefront_experiments), nullable = any
--   • exactly one of (subscribe_discount_pct, renewal_price_cents) carries the delta (CHECK)
--   • ends_at > starts_at when both present (CHECK) — every offer is explicitly time-boxed
-- RLS mirrors pricing_rules / advertorial_pages: workspace-member SELECT, service-role write.

-- ── pricing_rule_offers ────────────────────────────────────────────────────────
create table if not exists public.pricing_rule_offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The base rule this offer overlays. The offer does not replace the rule; it
  -- overrides the resolved S&S percentage (or pins a fixed renewal unit price) for
  -- in-scope product lines while it is active.
  pricing_rule_id uuid not null references public.pricing_rules(id) on delete cascade,

  -- ── scope: (product × lander_type × audience) / experiment ───────────────────
  -- All nullable. NULL on a dimension = "any" for that dimension. These document
  -- what the offer TARGETS; the renewal binding is via subscriptions.pricing_offer_id
  -- (the sub already won that scope at acquisition). product_id additionally narrows
  -- WHICH lines on an in-scope sub receive the delta (null = every product line).
  product_id uuid references public.products(id) on delete cascade,
  lander_type text check (lander_type in ('pdp', 'listicle', 'beforeafter', 'advertorial')),
  audience text,
  -- The experiment arm this offer is scoped to (the M4 optimizer proposes offers per arm).
  experiment_variant_id uuid references public.storefront_experiment_variants(id) on delete set null,

  -- ── the persist-to-renewal delta (exactly one) ──────────────────────────────
  -- subscribe_discount_pct: an OVERRIDE of the rule's S&S % for in-scope lines (e.g. 35
  --   when the base rule is 25). renewal_price_cents: a FIXED renewal unit price (cents)
  --   that pins the per-unit charge outright, ignoring base/break/S&S. Exactly one is set.
  subscribe_discount_pct int check (subscribe_discount_pct is null or (subscribe_discount_pct >= 0 and subscribe_discount_pct <= 100)),
  renewal_price_cents int check (renewal_price_cents is null or renewal_price_cents >= 0),
  constraint pricing_rule_offers_one_delta check (
    (subscribe_discount_pct is not null)::int + (renewal_price_cents is not null)::int = 1
  ),

  -- ── effective window — every offer is explicitly time-boxed, never the permanent default ──
  starts_at timestamptz,
  ends_at timestamptz,
  constraint pricing_rule_offers_window check (
    starts_at is null or ends_at is null or ends_at > starts_at
  ),

  -- ── lifecycle ────────────────────────────────────────────────────────────────
  -- proposed (agent drafted) → approved (owner signed off) → active (live, applied at
  -- renewal) → expired (window passed / rolled back). Only `active` rows are applied.
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'active', 'expired')),
  -- Human-readable label shown on the offer + honest customer-facing offer name.
  label text,
  -- Supervisability: who proposed/approved + free-text rationale (the agent surfaces its reasoning).
  proposed_by uuid,
  approved_by uuid,
  rationale text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Renewal-time lookup: an active offer for a workspace (+ optional product narrowing).
create index if not exists pricing_rule_offers_active_idx
  on public.pricing_rule_offers (workspace_id, status, product_id);
-- The rule this offer overlays, and the experiment arm it was scoped to.
create index if not exists pricing_rule_offers_rule_idx
  on public.pricing_rule_offers (pricing_rule_id);
create index if not exists pricing_rule_offers_variant_idx
  on public.pricing_rule_offers (experiment_variant_id);

-- ── RLS — workspace-member SELECT, service-role write ───────────────────────────
alter table public.pricing_rule_offers enable row level security;
drop policy if exists pricing_rule_offers_select on public.pricing_rule_offers;
create policy pricing_rule_offers_select on public.pricing_rule_offers
  for select to authenticated using (auth.uid() is not null);
drop policy if exists pricing_rule_offers_service on public.pricing_rule_offers;
create policy pricing_rule_offers_service on public.pricing_rule_offers
  for all to service_role using (true) with check (true);

-- ── subscriptions.pricing_offer_id — the persist-to-renewal reference ───────────
-- The offer this sub was acquired under (set by the deferred activation lever, gated by
-- owner approval). The renewal pricing engine reads it and applies the offer's delta while
-- the offer is `active` + in-window. A reference, NOT a baked price → expiring/removing the
-- offer reverts the sub to base pricing automatically (reversible-on-real-renewals).
alter table public.subscriptions
  add column if not exists pricing_offer_id uuid
    references public.pricing_rule_offers(id) on delete set null;
