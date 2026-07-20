-- media_buyer_cold_scaler_cohorts: the "cold scaler" designation for the Media
-- Buyer agent, sibling of media_buyer_test_cohorts. One row per (workspace,
-- meta_ad_account, product) marking the Meta scaler campaign the Media Buyer is
-- allowed to scale into, plus a per-day USD ceiling that caps that campaign's
-- spend. Bianca goal M4 ([[../../docs/brain/goals/bianca-temperature-aware-campaign-structure]]).
--
-- Distinct from media_buyer_test_cohorts, which bounds the TEST rail. This table
-- bounds the SCALER rail. The two are decoupled so the $600/day test ceiling and
-- the (typically much larger) scaler ceiling can move independently.
--
-- The M4 follow-on specs — arming gate, CAC:LTV sensor, graduate-crowned-winners
-- — all read this row to know (a) whether a scaler exists for the (workspace,
-- account, product) tuple, (b) what its daily ceiling is, and (c) whether it is
-- active. Ships EMPTY: the scaler surface is dormant until a workspace owner (or
-- a follow-on spec) inserts a row.
--
-- Precedence at read time (mirrors getEffectiveMediaBuyerTestCohort — introduced
-- by Phase 2 SDK, [[../../docs/brain/libraries/cold-scaler-cohort]]): most-specific
-- (account, product) → (account, product-null) → (account-null, product-null).
-- Partial unique index enforces "one active row per tuple" so precedence never
-- has to break a tie.

create table if not exists public.media_buyer_cold_scaler_cohorts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  product_id uuid references public.products(id),
  scaler_meta_campaign_id text,
  daily_scaler_ceiling_cents bigint not null check (daily_scaler_ceiling_cents > 0),
  is_active boolean not null default true,
  notes text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active scaler cohort per (workspace, meta_ad_account, product). NULLs on
-- meta_ad_account_id / product_id fall back to defaults at the workspace or
-- account level. Same coalesce-to-text shape as the test-cohort partial index so
-- the null-vs-null uniqueness collapses correctly (Postgres treats null values
-- as distinct in a normal unique index).
create unique index if not exists media_buyer_cold_scaler_cohorts_ws_account_product_active_key
  on public.media_buyer_cold_scaler_cohorts (
    workspace_id,
    coalesce(meta_ad_account_id::text, ''),
    coalesce(product_id::text, '')
  )
  where is_active = true;

create or replace function public.media_buyer_cold_scaler_cohorts_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_cold_scaler_cohorts_touch_updated_at on public.media_buyer_cold_scaler_cohorts;
create trigger media_buyer_cold_scaler_cohorts_touch_updated_at
  before update on public.media_buyer_cold_scaler_cohorts
  for each row execute function public.media_buyer_cold_scaler_cohorts_touch_updated_at();

alter table public.media_buyer_cold_scaler_cohorts enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'media_buyer_cold_scaler_cohorts'
      and policyname = 'media_buyer_cold_scaler_cohorts_select'
  ) then
    create policy media_buyer_cold_scaler_cohorts_select on public.media_buyer_cold_scaler_cohorts for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'media_buyer_cold_scaler_cohorts'
      and policyname = 'media_buyer_cold_scaler_cohorts_service'
  ) then
    create policy media_buyer_cold_scaler_cohorts_service on public.media_buyer_cold_scaler_cohorts for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
