-- Storefront Iteration Engine — Phase 1: Meta performance ingestion.
--
-- Mirrors Meta's campaign/adset/ad STRUCTURE locally (none stored today — only
-- the account-level `daily_meta_ad_spend` rollup existed) plus daily INSIGHTS at
-- object grain. The iteration engine reads these (via Phase 3 scorecards) to
-- score and act on ads/adsets/campaigns. ShopCX-built ads map to these rows via
-- the existing `ad_publish_jobs.meta_ad_id`/`meta_adset_id`/`meta_campaign_id`
-- (no new column needed). See docs/brain/specs/storefront-iteration-engine.md.
--
-- Meta object ids are the natural keys; internal joins still use our uuid PKs.
-- Budgets are stored in minor units (cents) of the account currency.

-- ── Campaigns ────────────────────────────────────────────────────────────────
create table if not exists public.meta_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  meta_campaign_id text not null,                  -- Meta's campaign id (natural key)
  name text,
  status text,                                     -- configured status: ACTIVE | PAUSED | ...
  effective_status text,                           -- Meta's computed status
  objective text,
  daily_budget_cents bigint,                       -- CBO campaign-level budget (null under ABO)
  lifetime_budget_cents bigint,
  meta_created_time timestamptz,                   -- Meta's created_time
  meta_updated_time timestamptz,                   -- Meta's updated_time
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, meta_campaign_id)
);

create index if not exists meta_campaigns_account_idx
  on public.meta_campaigns (meta_ad_account_id);

-- ── Ad sets ──────────────────────────────────────────────────────────────────
create table if not exists public.meta_adsets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  meta_adset_id text not null,                     -- Meta's adset id (natural key)
  meta_campaign_id text,                           -- parent campaign (Meta id)
  name text,
  status text,
  effective_status text,
  optimization_goal text,
  daily_budget_cents bigint,                       -- ABO adset-level budget (null under CBO)
  lifetime_budget_cents bigint,
  meta_created_time timestamptz,
  meta_updated_time timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, meta_adset_id)
);

create index if not exists meta_adsets_account_idx
  on public.meta_adsets (meta_ad_account_id);
create index if not exists meta_adsets_campaign_idx
  on public.meta_adsets (workspace_id, meta_campaign_id);

-- ── Ads ──────────────────────────────────────────────────────────────────────
create table if not exists public.meta_ads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  meta_ad_id text not null,                        -- Meta's ad id (natural key)
  meta_adset_id text,                              -- parent adset (Meta id)
  meta_campaign_id text,                           -- parent campaign (Meta id)
  name text,
  status text,
  effective_status text,
  creative_id text,
  meta_created_time timestamptz,
  meta_updated_time timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, meta_ad_id)
);

create index if not exists meta_ads_account_idx
  on public.meta_ads (meta_ad_account_id);
create index if not exists meta_ads_adset_idx
  on public.meta_ads (workspace_id, meta_adset_id);

-- ── Daily insights at object grain ───────────────────────────────────────────
-- One row per (workspace, meta object, level, day). `level` ∈ campaign|adset|ad.
-- Idempotent upsert key is (workspace_id, meta_object_id, level, snapshot_date).
create table if not exists public.meta_insights_daily (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  level text not null check (level in ('campaign', 'adset', 'ad')),
  meta_object_id text not null,                    -- campaign/adset/ad id for this level
  snapshot_date date not null,

  spend_cents bigint not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  ctr numeric not null default 0,                  -- percent, as reported by Meta
  cpc_cents bigint not null default 0,
  purchases int not null default 0,
  revenue_cents bigint not null default 0,         -- purchase conversion value
  roas numeric not null default 0,                 -- revenue / spend (derived)
  frequency numeric not null default 0,
  currency text not null default 'USD',
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, meta_object_id, level, snapshot_date)
);

create index if not exists meta_insights_daily_account_date_idx
  on public.meta_insights_daily (meta_ad_account_id, snapshot_date);
create index if not exists meta_insights_daily_level_object_idx
  on public.meta_insights_daily (workspace_id, level, meta_object_id, snapshot_date);

-- ── RLS: members read their workspace; service role full ─────────────────────
alter table public.meta_campaigns enable row level security;
alter table public.meta_adsets enable row level security;
alter table public.meta_ads enable row level security;
alter table public.meta_insights_daily enable row level security;

drop policy if exists meta_campaigns_select on public.meta_campaigns;
create policy meta_campaigns_select on public.meta_campaigns
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists meta_campaigns_service on public.meta_campaigns;
create policy meta_campaigns_service on public.meta_campaigns
  for all to service_role using (true) with check (true);

drop policy if exists meta_adsets_select on public.meta_adsets;
create policy meta_adsets_select on public.meta_adsets
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists meta_adsets_service on public.meta_adsets;
create policy meta_adsets_service on public.meta_adsets
  for all to service_role using (true) with check (true);

drop policy if exists meta_ads_select on public.meta_ads;
create policy meta_ads_select on public.meta_ads
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists meta_ads_service on public.meta_ads;
create policy meta_ads_service on public.meta_ads
  for all to service_role using (true) with check (true);

drop policy if exists meta_insights_daily_select on public.meta_insights_daily;
create policy meta_insights_daily_select on public.meta_insights_daily
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists meta_insights_daily_service on public.meta_insights_daily;
create policy meta_insights_daily_service on public.meta_insights_daily
  for all to service_role using (true) with check (true);
