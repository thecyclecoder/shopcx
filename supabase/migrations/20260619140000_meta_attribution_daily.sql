-- Storefront Iteration Engine — Phase 2: Attribution & variant linkage.
--
-- Persists attributed spend + revenue at the (meta_ad_id, variant, snapshot_date)
-- grain so per-variant unit economics exist. Spend comes from the ad's daily
-- `meta_insights_daily` row, allocated across the variants the ad drove by Meta
-- SESSION share; revenue comes from Meta-attributed `orders`, resolved to a lander
-- variant via the customer's first-touch Meta `storefront_sessions` row → angle slug
-- → `advertorial_pages`. Spend/revenue that can't be resolved falls to a
-- `variant = '(unresolved)'` bucket so totals are always conserved (the named
-- `variant_attribution_coverage` metric is reported per run, never silent).
--
-- Written by src/lib/meta/attribution.ts (computeVariantAttribution). Read by the
-- Phase 3 scorecards. See docs/brain/specs/storefront-iteration-engine.md (Phase 2).
--
-- Idempotent upsert key: (workspace_id, meta_ad_id, variant, snapshot_date).
-- Spend/revenue stored in minor units (cents) of the account currency.

create table if not exists public.meta_attribution_daily (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  meta_ad_id text not null,                          -- Meta ad id (= orders.attributed_utm_content by convention)
  variant text not null,                             -- advertorial | beforeafter | reasons | '(unresolved)'
  snapshot_date date not null,

  -- resolved lander context (null on the '(unresolved)' bucket); dominant per cell
  advertorial_page_id uuid references public.advertorial_pages(id) on delete set null,
  angle_id uuid references public.product_ad_angles(id) on delete set null,
  ad_campaign_id uuid references public.ad_campaigns(id) on delete set null,
  meta_adset_id text,                                -- parent Meta adset (context, from meta_ads)
  meta_campaign_id text,                             -- parent Meta campaign (context, from meta_ads)

  sessions int not null default 0,                   -- in-window Meta sessions for this ad+variant+day
  attributed_spend_cents bigint not null default 0,  -- ad spend allocated by session share
  orders int not null default 0,
  revenue_cents bigint not null default 0,           -- Meta-attributed order revenue
  roas numeric not null default 0,                   -- revenue / spend (derived)

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, meta_ad_id, variant, snapshot_date)
);

create index if not exists meta_attribution_daily_account_date_idx
  on public.meta_attribution_daily (meta_ad_account_id, snapshot_date);
create index if not exists meta_attribution_daily_ad_idx
  on public.meta_attribution_daily (workspace_id, meta_ad_id, snapshot_date);
create index if not exists meta_attribution_daily_variant_idx
  on public.meta_attribution_daily (workspace_id, variant, snapshot_date);

-- ── RLS: members read their workspace; service role full ─────────────────────
alter table public.meta_attribution_daily enable row level security;

drop policy if exists meta_attribution_daily_select on public.meta_attribution_daily;
create policy meta_attribution_daily_select on public.meta_attribution_daily
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists meta_attribution_daily_service on public.meta_attribution_daily;
create policy meta_attribution_daily_service on public.meta_attribution_daily
  for all to service_role using (true) with check (true);
