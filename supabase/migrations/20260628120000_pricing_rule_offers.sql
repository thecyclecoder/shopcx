-- Dynamic, time-boxed persist-to-renewal offers — M6 of the storefront-optimizer goal
-- (docs/brain/specs/storefront-dynamic-renewal-offers.md).
--
-- pricing_rules is static per product (one rule, read live by the renewal/portal pricing
-- engine — src/lib/pricing.ts). An offer that PERSISTS TO RENEWAL bleeds margin on every
-- renewal, so it is the gated, highest-stakes optimizer lever — never autonomous. This
-- migration makes the offer a dynamic CHILD of pricing_rules so the base rule stays
-- static and the offer is scoped, time-boxed, owner-approved, and cleanly reversible.
--
-- Two tables + two ALTERs:
--   pricing_rule_offers        — one scoped, time-boxed renewal-price override (a
--                                subscribe_discount_pct override OR a fixed renewal price),
--                                tied to a (product × lander_type × audience) / experiment
--                                arm, with status ∈ proposed|approved|active|expired.
--   pricing_rule_offer_events  — append-only audit trail (proposed/approved/activated/
--                                expired/rolled_back/margin_blocked) — a persist-to-renewal
--                                offer touched real renewals, so every state change is logged.
--   subscriptions.pricing_rule_offer_id  — the binding: a sub that converted on the offer
--                                arm carries a REFERENCE to the offer (never a baked price),
--                                so the engine resolves it live at renewal and a deactivated
--                                offer reverts the sub to base pricing with nothing to un-bake.
--   storefront_optimizer_policy.renewal_margin_floor_pct  — the configured margin floor the
--                                agent may never propose below (breach ⇒ escalate, not propose).
--
-- Safety invariants baked in here:
--   • status CHECK ∈ proposed|approved|active|expired (default proposed — inactive)
--   • offer_type CHECK ∈ subscribe_discount_pct|fixed_renewal_price, with a CHECK that the
--     matching value column is set (no offer with neither override)
--   • lander_type CHECK ∈ pdp|listicle|beforeafter|advertorial (null = all lander types)
--   • subscribe_discount_pct in [0,100]; renewal_price_cents >= 0; ends_at > starts_at
-- RLS mirrors storefront_experiments: workspace-member SELECT, service-role write.

-- ── pricing_rule_offers ─────────────────────────────────────────────────────────
create table if not exists public.pricing_rule_offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The product the offer is scoped to (the renewal engine resolves the offer per
  -- product line). Joins on the UUID, never a shopify id.
  product_id uuid not null references public.products(id) on delete cascade,
  -- The base rule the offer overrides. Nullable — when null the engine resolves the
  -- product's rule live (the offer still applies to the product's lines).
  pricing_rule_id uuid references public.pricing_rules(id) on delete set null,
  -- Experiment-scoped: the M1 experiment + arm this offer is the variant for. The bandit
  -- runs the offer arm vs holdout and attributes outcomes on the M3 LTV proxy. Nullable so
  -- a future direct owner offer can exist without an experiment.
  experiment_id uuid references public.storefront_experiments(id) on delete set null,
  variant_id uuid references public.storefront_experiment_variants(id) on delete set null,

  -- ── scope (the (product × lander_type × audience) the offer applies to) ─────────
  -- lander_type null = all lander types for the product. audience default 'all'.
  lander_type text check (lander_type in ('pdp', 'listicle', 'beforeafter', 'advertorial')),
  audience text not null default 'all',

  -- ── the persist-to-renewal price delta ──────────────────────────────────────────
  -- subscribe_discount_pct  → override the rule's S&S percent at renewal (stacks with
  --                           the existing quantity break, like the base rule's sns).
  -- fixed_renewal_price     → a fixed per-unit renewal price (overrides break + sns).
  offer_type text not null check (offer_type in ('subscribe_discount_pct', 'fixed_renewal_price')),
  subscribe_discount_pct integer check (subscribe_discount_pct >= 0 and subscribe_discount_pct <= 100),
  renewal_price_cents integer check (renewal_price_cents >= 0),

  -- ── the effective window (time-boxed — never the silent permanent default) ───────
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,

  -- ── lifecycle ────────────────────────────────────────────────────────────────────
  -- proposed → approved → active → expired. Created proposed (inactive); only the owner's
  -- approval moves it forward. The engine applies the offer ONLY while status='active'.
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'active', 'expired')),

  -- ── margin-floor bookkeeping (Phase 3 hard rail) ─────────────────────────────────
  -- The modeled renewal margin at proposal time + the floor it was checked against. An
  -- offer below the floor is BLOCKED (escalated to Growth + CFO), never surfaced as a
  -- normal approvable proposal. cogs_source_missing flags placeholder economics (M3).
  modeled_renewal_margin_pct numeric,
  margin_floor_pct numeric,
  margin_floor_ok boolean,
  cogs_source_missing boolean not null default true,

  -- ── legibility / supervisability (the north star — surface the reasoning) ────────
  hypothesis text,
  rationale text,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  activated_at timestamptz,
  expired_at timestamptz,
  -- Why the offer was deactivated (auto_expired | experiment_rolled_back | experiment_killed
  -- | owner_revoked) — the audit reason a renewal-touching offer must carry on rollback.
  deactivation_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An offer must carry the value matching its type — no offer with neither override.
  constraint pricing_rule_offers_value_present check (
    (offer_type = 'subscribe_discount_pct' and subscribe_discount_pct is not null)
    or (offer_type = 'fixed_renewal_price' and renewal_price_cents is not null)
  ),
  constraint pricing_rule_offers_window check (ends_at > starts_at)
);

create index if not exists pricing_rule_offers_ws_status_idx
  on public.pricing_rule_offers (workspace_id, status);
-- Renewal-engine lookup: the active offer(s) for a product within the window.
create index if not exists pricing_rule_offers_product_active_idx
  on public.pricing_rule_offers (workspace_id, product_id, status);
create index if not exists pricing_rule_offers_experiment_idx
  on public.pricing_rule_offers (experiment_id);

-- ── pricing_rule_offer_events (append-only audit trail) ──────────────────────────
create table if not exists public.pricing_rule_offer_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  offer_id uuid not null references public.pricing_rule_offers(id) on delete cascade,
  -- proposed | margin_blocked | approved | activated | expired | rolled_back | killed | revoked
  event text not null,
  -- The actor — an auth.users id (owner approval) or the agent literal. Plain text so the
  -- agent ('storefront-optimizer') and a human uuid both fit (no FK to auth.users — the
  -- pooler apply role lacks REFERENCES on the auth schema, mirroring the storefront tables).
  actor text,
  reason text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists pricing_rule_offer_events_offer_idx
  on public.pricing_rule_offer_events (offer_id, created_at desc);

-- ── subscriptions binding — the sub carries a REFERENCE to the offer, not a price ──
-- A sub that converted on the offer arm references the offer; the engine resolves it live
-- at renewal. Deactivation reverts the sub to base pricing with NOTHING baked to un-bake
-- (the "reversible on real renewals" invariant). FK set-null so a deleted offer can't
-- dangle the sub (it just reverts to base).
alter table public.subscriptions
  add column if not exists pricing_rule_offer_id uuid;
alter table public.subscriptions
  drop constraint if exists subscriptions_pricing_rule_offer_fk;
alter table public.subscriptions
  add constraint subscriptions_pricing_rule_offer_fk
  foreign key (pricing_rule_offer_id)
  references public.pricing_rule_offers(id) on delete set null;

-- ── storefront_optimizer_policy — the configured renewal-margin floor ─────────────
-- The agent may never PROPOSE an offer whose modeled renewal margin drops below this; a
-- breach escalates to Growth + CFO. Default 0.35 (35% modeled gross margin floor).
alter table public.storefront_optimizer_policy
  add column if not exists renewal_margin_floor_pct double precision not null default 0.35;

-- ── seed the renewal-offer LEVER into the M2 taxonomy ─────────────────────────────
-- The offer is a NEW pricing-table component lever (CRO lever #2 chapter). Seeding it makes
-- it a rankable nextLeverToTest candidate so the optimizer can pick it — but it is OFFER
-- CLASS (always approval-gated), routed via the offer path, never the autonomous coupon one.
insert into public.storefront_levers (lever_key, chapter, kind, parent_lever_id, label, prior, default_scope, description)
select 'renewal_offer', 'pricing_table', 'component', p.id, 'Persist-to-renewal offer', 0.50, 'product_specific',
       'A scoped, time-boxed persist-to-renewal price override (M6) — ALWAYS owner-approved, bleeds margin on every renewal.'
from public.storefront_levers p
where p.lever_key = 'pricing_table'
on conflict (lever_key) do nothing;

-- ── RLS — workspace-member SELECT, service-role write (mirror storefront_experiments) ──
alter table public.pricing_rule_offers enable row level security;
drop policy if exists pricing_rule_offers_select on public.pricing_rule_offers;
create policy pricing_rule_offers_select on public.pricing_rule_offers
  for select to authenticated using (auth.uid() is not null);
drop policy if exists pricing_rule_offers_service on public.pricing_rule_offers;
create policy pricing_rule_offers_service on public.pricing_rule_offers
  for all to service_role using (true) with check (true);

alter table public.pricing_rule_offer_events enable row level security;
drop policy if exists pricing_rule_offer_events_select on public.pricing_rule_offer_events;
create policy pricing_rule_offer_events_select on public.pricing_rule_offer_events
  for select to authenticated using (auth.uid() is not null);
drop policy if exists pricing_rule_offer_events_service on public.pricing_rule_offer_events;
create policy pricing_rule_offer_events_service on public.pricing_rule_offer_events
  for all to service_role using (true) with check (true);
