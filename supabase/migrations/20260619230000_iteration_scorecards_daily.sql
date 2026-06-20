-- Storefront Iteration Engine — Phase 3: Metrics rollups / scorecards.
--
-- The deterministic daily metrics the controller reads. The engine NEVER queries
-- raw session/insight tables — it reads THIS table. One row per
-- (workspace_id, level, object_id, snapshot_date), where `level` ∈
-- ad | adset | campaign | variant | angle.
--
-- Each row is a TRAILING-WINDOW rollup (default 7 days) ending at `snapshot_date`,
-- with the prior equal-length window stored for trend + fatigue signals. Sources:
--   - ad/adset/campaign → `meta_insights_daily` (authoritative Meta spend/impr/
--     clicks/ctr/cpc/frequency/purchases/revenue/roas) + `meta_ads`/`meta_adsets`/
--     `meta_campaigns` structure (name, status, days_live, creatives_live).
--   - variant/angle → `meta_attribution_daily` (per-variant attributed spend +
--     revenue + sessions + orders); variant ATC from `storefront_events`.
--   - angle context (lead_benefit_anchor / benefit_name) → `ad_campaigns.angle_id`
--     → `product_ad_angles.lead_benefit_anchor` → `product_benefit_selections`
--     (role='lead' AND science_confirmed=true).
--
-- Written by src/lib/meta/scorecards.ts (computeScorecards). Recommendation +
-- policy actions (Phases 4/6) cite scorecard rows by `id`. Agent-legible + typed
-- so the future Growth Director can read it with no migration.
--
-- Idempotent upsert key: (workspace_id, level, object_id, snapshot_date).
-- Monetary fields are minor units (cents) of the account currency.
-- See docs/brain/specs/storefront-iteration-engine.md (Phase 3).

create table if not exists public.iteration_scorecards_daily (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  level text not null check (level in ('ad', 'adset', 'campaign', 'variant', 'angle')),
  object_id text not null,                           -- meta object id | variant slug | angle uuid (as text)
  snapshot_date date not null,                       -- as-of day (window ends here)
  window_days int not null default 7,                -- trailing-window length

  label text,                                        -- human-legible: name | variant | benefit
  effective_status text,                             -- current Meta status (ad/adset/campaign)

  -- ── context / parents ───────────────────────────────────────────────────────
  parent_adset_id text,                              -- ad → adset (Meta id)
  parent_campaign_id text,                           -- ad/adset → campaign (Meta id)
  angle_id uuid references public.product_ad_angles(id) on delete set null,
  advertorial_page_id uuid references public.advertorial_pages(id) on delete set null,
  lead_benefit_anchor text,                          -- angle: verbatim anchor string
  benefit_name text,                                 -- angle: resolved product_benefit_selections.benefit_name

  -- ── window metrics ──────────────────────────────────────────────────────────
  spend_cents bigint not null default 0,
  revenue_cents bigint not null default 0,
  roas numeric not null default 0,                   -- revenue / spend
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  ctr numeric not null default 0,                    -- percent (clicks / impressions * 100)
  cpc_cents bigint not null default 0,
  frequency numeric not null default 0,              -- avg daily frequency in window
  purchases int not null default 0,                  -- Meta-reported purchases (insights)
  orders int not null default 0,                     -- attributed orders (attribution)
  sessions int not null default 0,                   -- Meta sessions (attribution / variant)
  atc int not null default 0,                        -- variant: sessions with an add_to_cart
  atc_rate numeric not null default 0,               -- variant: atc / sessions
  cvr numeric not null default 0,                    -- ad/adset/campaign: purchases/clicks · variant/angle: orders/sessions
  days_live int not null default 0,                  -- days since the object's Meta created_time
  creatives_live int not null default 0,             -- adset/campaign: count of ACTIVE child ads
  variant_attribution_coverage numeric,              -- variant/angle: account-level resolved-session share (named, not silent)

  -- ── trend (prior equal-length window) ───────────────────────────────────────
  spend_prev_cents bigint not null default 0,
  revenue_prev_cents bigint not null default 0,
  roas_prev numeric not null default 0,
  ctr_prev numeric not null default 0,
  frequency_prev numeric not null default 0,
  sessions_prev int not null default 0,
  cvr_prev numeric not null default 0,
  roas_delta_pct numeric,                            -- (curr-prev)/prev; null when prev=0
  ctr_delta_pct numeric,
  spend_delta_pct numeric,
  revenue_delta_pct numeric,

  -- ── fatigue signals ─────────────────────────────────────────────────────────
  ctr_declining boolean not null default false,      -- CTR down materially vs prior window
  frequency_rising boolean not null default false,   -- avg frequency up vs prior window
  fatigue_score numeric not null default 0,          -- 0..1 composite (CTR decline + freq rise + ROAS decline)

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, level, object_id, snapshot_date)
);

create index if not exists iteration_scorecards_daily_account_date_idx
  on public.iteration_scorecards_daily (meta_ad_account_id, snapshot_date);
create index if not exists iteration_scorecards_daily_level_idx
  on public.iteration_scorecards_daily (workspace_id, level, snapshot_date);
create index if not exists iteration_scorecards_daily_object_idx
  on public.iteration_scorecards_daily (workspace_id, level, object_id, snapshot_date);

-- ── RLS: members read their workspace; service role full ─────────────────────
alter table public.iteration_scorecards_daily enable row level security;

drop policy if exists iteration_scorecards_daily_select on public.iteration_scorecards_daily;
create policy iteration_scorecards_daily_select on public.iteration_scorecards_daily
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists iteration_scorecards_daily_service on public.iteration_scorecards_daily;
create policy iteration_scorecards_daily_service on public.iteration_scorecards_daily
  for all to service_role using (true) with check (true);
