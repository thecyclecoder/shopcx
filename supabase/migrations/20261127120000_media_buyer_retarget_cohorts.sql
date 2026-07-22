-- media_buyer_retarget_cohorts: the "retarget campaign" designation for the
-- Media Buyer agent, third sibling of media_buyer_test_cohorts +
-- media_buyer_cold_scaler_cohorts. One row per (workspace, meta_ad_account,
-- product) marking the Meta retarget CAMPAIGN + consolidated ADSET the
-- retarget rail is allowed to publish warm/hot creatives into, plus a per-day
-- USD ceiling that caps that adset's spend and the whitelist of audience
-- temperatures allowed to publish (defaults to '{warm,hot}').
-- v3 Ad Creative Engine goal M3 ([[../../docs/brain/goals/v3-ad-creative-engine]]).
--
-- Distinct from media_buyer_test_cohorts (bounds the TEST rail — cold-only per
-- bianca-route-ready-creatives-by-dahlia-temperature-tag) and
-- media_buyer_cold_scaler_cohorts (bounds the cold SCALER rail). This table
-- bounds the retarget rail — warm+hot MIXED content into one consolidated
-- retarget adset — and gates its publish path. The three tables are decoupled
-- so each rail's ceiling, adset, and audience_temperatures move independently.
--
-- The retarget replenish sibling (Phase 2 spec) reads this row to know
-- (a) whether a retarget cohort exists for the (workspace, account, product)
-- tuple, (b) the retarget_meta_adset_id it publishes into, (c) the daily
-- ceiling that bounds spend, and (d) the audience_temperatures whitelist it
-- filters the ready-to-test bin by. Ships EMPTY: the retarget rail is dormant
-- until a workspace owner (via provisionRetargetCohort) inserts a row.
--
-- Precedence at read time (mirrors getEffectiveMediaBuyerColdScalerCohort +
-- getEffectiveMediaBuyerTestCohort): most-specific
-- (account, product) → (account, product-null) → (account-null, product-null).
-- Partial unique index enforces "one active row per tuple" so precedence never
-- has to break a tie.

create table if not exists public.media_buyer_retarget_cohorts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  product_id uuid references public.products(id),
  retarget_meta_campaign_id text not null,
  retarget_meta_adset_id text not null,
  daily_ceiling_cents bigint not null check (daily_ceiling_cents > 0),
  audience_temperatures text[] not null default '{warm,hot}',
  default_meta_page_id text,
  default_meta_instagram_user_id text,
  is_active boolean not null default true,
  notes text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active retarget cohort per (workspace, meta_ad_account, product). NULLs on
-- meta_ad_account_id / product_id fall back to defaults at the workspace or
-- account level. Same coalesce-to-text shape as the test-cohort + cold-scaler
-- partial indices so the null-vs-null uniqueness collapses correctly (Postgres
-- treats null values as distinct in a normal unique index).
create unique index if not exists media_buyer_retarget_cohorts_ws_account_product_active_key
  on public.media_buyer_retarget_cohorts (
    workspace_id,
    coalesce(meta_ad_account_id::text, ''),
    coalesce(product_id::text, '')
  )
  where is_active = true;

create or replace function public.media_buyer_retarget_cohorts_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_retarget_cohorts_touch_updated_at on public.media_buyer_retarget_cohorts;
create trigger media_buyer_retarget_cohorts_touch_updated_at
  before update on public.media_buyer_retarget_cohorts
  for each row execute function public.media_buyer_retarget_cohorts_touch_updated_at();

alter table public.media_buyer_retarget_cohorts enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'media_buyer_retarget_cohorts'
      and policyname = 'media_buyer_retarget_cohorts_select'
  ) then
    create policy media_buyer_retarget_cohorts_select on public.media_buyer_retarget_cohorts for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'media_buyer_retarget_cohorts'
      and policyname = 'media_buyer_retarget_cohorts_service'
  ) then
    create policy media_buyer_retarget_cohorts_service on public.media_buyer_retarget_cohorts for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
