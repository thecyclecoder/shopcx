-- Dynamic, time-boxed persist-to-renewal offer model — the offer *model* (P1) for
-- docs/brain/specs/storefront-dynamic-renewal-offers.md (M6 of the storefront-optimizer goal).
--
-- RECONCILED to the live schema (2026-06-24): the table was first created out-of-band by a
-- prematurely-merged box build (closed PR #281) carrying the full guardrail shape, so this
-- migration is rewritten to CREATE THAT SAME rich table (IF NOT EXISTS → a no-op on prod, and
-- the correct shape on a fresh DB). The margin-floor / expiry / rollback guardrail COLUMNS are
-- populated by the deferred activation lever (docs/brain/specs/storefront-renewal-offer-lever.md);
-- they live on the table here because the table physically exists with them — the database is the spec.
--
-- North-star split: a first-order coupon stays on the autonomous coupons path; an offer that
-- persists to renewal bleeds margin on every renewal, so it is ALWAYS owner-approved
-- (status proposed → approved → active → expired) and is NEVER autonomous.
--
-- Mechanism (mirrors the engine's "references, not baked prices" philosophy): a sub records WHICH
-- offer it was acquired under via subscriptions.pricing_offer_id (a reference, not a baked price).
-- The renewal engine reads that reference; if the offer is still `active` and inside its
-- [starts_at, ends_at] window, it applies the delta — so the offer persists to renewal and is
-- cleanly reversible (expire the offer / null the column → base pricing).

-- ── pricing_rule_offers ────────────────────────────────────────────────────────
create table if not exists public.pricing_rule_offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- product the offer targets (NOT NULL — every offer is product-scoped); narrows which lines
  -- on an in-scope sub receive the delta.
  product_id uuid not null references public.products(id) on delete cascade,
  -- The base rule this offer overlays (does not replace it). on delete set null — losing the rule
  -- doesn't drop the offer history.
  pricing_rule_id uuid references public.pricing_rules(id) on delete set null,

  -- ── scope: experiment arm (the M4 optimizer proposes offers per arm) ──────────
  experiment_id uuid references public.storefront_experiments(id) on delete set null,
  variant_id uuid references public.storefront_experiment_variants(id) on delete set null,
  lander_type text check (lander_type in ('pdp', 'listicle', 'beforeafter', 'advertorial')),
  audience text not null default 'all',

  -- ── the persist-to-renewal delta (discriminated by offer_type) ───────────────
  -- subscribe_discount_pct: an OVERRIDE of the rule's S&S % for in-scope lines. renewal_price_cents:
  -- a FIXED renewal unit price (cents) that pins the per-unit charge outright. The value_present
  -- CHECK ties offer_type to whichever column must be set.
  offer_type text not null check (offer_type in ('subscribe_discount_pct', 'fixed_renewal_price')),
  subscribe_discount_pct int check (subscribe_discount_pct is null or (subscribe_discount_pct >= 0 and subscribe_discount_pct <= 100)),
  renewal_price_cents int check (renewal_price_cents is null or renewal_price_cents >= 0),
  constraint pricing_rule_offers_value_present check (
    (offer_type = 'subscribe_discount_pct' and subscribe_discount_pct is not null)
    or (offer_type = 'fixed_renewal_price' and renewal_price_cents is not null)
  ),

  -- ── effective window — every offer is explicitly time-boxed ──────────────────
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  constraint pricing_rule_offers_window check (ends_at > starts_at),

  -- ── lifecycle ────────────────────────────────────────────────────────────────
  -- proposed → approved → active → expired. Only `active` rows are applied at renewal.
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'active', 'expired')),

  -- ── margin guardrails (populated by the deferred activation lever) ───────────
  modeled_renewal_margin_pct numeric,
  margin_floor_pct numeric,
  margin_floor_ok boolean,
  cogs_source_missing boolean not null default true,

  -- ── supervisability — surfaced reasoning + who proposed/approved ─────────────
  hypothesis text,
  rationale text,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  activated_at timestamptz,
  expired_at timestamptz,
  deactivation_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Renewal-time lookup: an active offer for a workspace (+ product narrowing) + the experiment arm.
create index if not exists pricing_rule_offers_ws_status_idx
  on public.pricing_rule_offers (workspace_id, status);
create index if not exists pricing_rule_offers_product_active_idx
  on public.pricing_rule_offers (workspace_id, product_id, status);
create index if not exists pricing_rule_offers_experiment_idx
  on public.pricing_rule_offers (experiment_id);

-- ── RLS — workspace-member SELECT, service-role write ───────────────────────────
alter table public.pricing_rule_offers enable row level security;
drop policy if exists pricing_rule_offers_select on public.pricing_rule_offers;
create policy pricing_rule_offers_select on public.pricing_rule_offers
  for select to authenticated using (auth.uid() is not null);
drop policy if exists pricing_rule_offers_service on public.pricing_rule_offers;
create policy pricing_rule_offers_service on public.pricing_rule_offers
  for all to service_role using (true) with check (true);

-- ── subscriptions.pricing_offer_id — the persist-to-renewal reference ───────────
-- The offer this sub was acquired under (set by the deferred activation lever, gated by owner
-- approval). The renewal pricing engine reads it and applies the offer's delta while the offer is
-- `active` + in-window. A reference, NOT a baked price → expiring/removing the offer reverts the
-- sub to base pricing automatically (reversible-on-real-renewals). This is the one piece the
-- premature build never added, so it actually applies on prod.
alter table public.subscriptions
  add column if not exists pricing_offer_id uuid
    references public.pricing_rule_offers(id) on delete set null;
create index if not exists subscriptions_pricing_offer_idx
  on public.subscriptions (pricing_offer_id) where pricing_offer_id is not null;
