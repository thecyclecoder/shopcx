-- create_offers — Phase 1 of offer-creator.
--
-- The offers table: an admin layer over pricing rules that attaches extra
-- included products (physical or digital) to a specific product variant.
-- Adding that variant to the cart later (Phase 2) will attach the included
-- items as $0 lines. Physical items carry a real sku and reach Amplifier;
-- digital items carry no sku and trigger digital-goods-delivery. When
-- `overrides_pricing_rule_gifts=true` the offer's included items replace
-- any free_gift attached via the base [[pricing_rules]] (Phase 2 wiring).
--
-- Scope semantics:
--   `checkout_only`           = the offer's items ship with the first
--                               (checkout) order and are stripped from
--                               every subscription renewal (Phase 3).
--   `checkout_and_renewals`   = the offer's items ship every renewal too
--                               (used sparingly — turns the extras into
--                               recurring cost).
--
-- Distinct from the existing `pricing_rule_offers` table (dynamic
-- renewal-price offers, [[docs/brain/tables/pricing_rule_offers.md]]).
-- This one attaches EXTRA line items, not a per-unit price override.
--
-- Additive, idempotent (IF NOT EXISTS + drop/create policy). RLS ENABLED
-- with a service_role full-access policy (house convention — every
-- read/write flows through server-side code via createAdminClient()).

create table if not exists public.offers (
  id                             uuid primary key default gen_random_uuid(),
  workspace_id                   uuid not null references public.workspaces(id) on delete cascade,
  variant_id                     uuid not null references public.product_variants(id) on delete cascade,
  name                           text null,
  included                       jsonb not null default '[]'::jsonb,
  scope                          text not null default 'checkout_only'
                                   check (scope in ('checkout_only', 'checkout_and_renewals')),
  overrides_pricing_rule_gifts   boolean not null default false,
  is_active                      boolean not null default true,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

-- Phase 2 checkout-lookup: for a given variant, "does an active offer
-- exist to attach?" — bounded by workspace + variant. One active offer
-- per variant is the intent; the uniqueness is enforced at write time
-- by the admin route (not the DB) so a workspace can stage an inactive
-- draft while the current one is live.
create index if not exists offers_workspace_variant_idx
  on public.offers (workspace_id, variant_id) where is_active;

-- Admin-list index (Phase 1 UI).
create index if not exists offers_workspace_idx
  on public.offers (workspace_id);

-- `included` shape: array of { ref_id: uuid, kind: 'physical' | 'digital',
-- quantity: int }. `physical` → ref_id points at product_variants.id (the
-- sku-bearing line the cart attaches). `digital` → ref_id points at
-- digital_goods.id (the no-sku line that triggers digital-goods-delivery
-- attachment email). Shape validated at write time by the admin route;
-- a lightweight jsonb check keeps clearly-malformed payloads out.
alter table public.offers
  drop constraint if exists offers_included_is_array;
alter table public.offers
  add constraint offers_included_is_array check (jsonb_typeof(included) = 'array');

alter table public.offers enable row level security;
drop policy if exists offers_service on public.offers;
create policy offers_service on public.offers
  for all to service_role using (true) with check (true);

comment on table public.offers is
  'Offer-creator table — one row per (workspace, variant) attach-extra-items offer. Phase 1 of offer-creator. Read at cart-build (Phase 2) by src/lib/cart-gifts.ts to attach included items as $0 lines; stripped at renewal (Phase 3) when scope=checkout_only. See docs/brain/tables/offers.md.';
comment on column public.offers.included is
  'jsonb array of { ref_id, kind, quantity }. kind=physical → ref_id is product_variants.id (Amplifier sku-bearing). kind=digital → ref_id is digital_goods.id (no sku, triggers digital-goods-delivery). Shape validated at write time by the admin route.';
comment on column public.offers.scope is
  'checkout_only = attached to first order only, stripped at renewal (Phase 3). checkout_and_renewals = attached every renewal too.';
comment on column public.offers.overrides_pricing_rule_gifts is
  'When true, this offer replaces the free_gift attached via pricing_rules for cart-build lookups (Phase 2 wiring in cart-gifts.ts).';
