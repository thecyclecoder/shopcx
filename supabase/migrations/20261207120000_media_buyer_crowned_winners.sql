-- media_buyer_crowned_winners: durable per-workspace ledger of every test adset
-- that was crowned a winner by the Media Buyer's test loop. Mirrors
-- 20261022120002_media_buyer_cold_scaler_cohorts.sql (RLS shape + service-role
-- writes + trigger for updated_at).
--
-- Introduced by [[../../docs/brain/specs/media-buyer-persist-crowned-winners-and-guard-reactivation]]
-- Phase 1.
--
-- Why: Crowning is a READ-TIME verdict today (recomputed each Media Buyer pass
-- from meta insights + policy knobs). Nothing persists the fact that a specific
-- test adset was crowned and eligible to graduate to the scaler, and there is
-- no link from the test winner to its scaler duplicate. Bianca's recovered-CPA
-- reactivation only avoids resurrecting a graduate BY ACCIDENT — it happens to
-- only consider adsets she paused as losers. A crown BY DEFINITION has CPA at
-- or below the crown target, which IS the reactivation threshold, so the day a
-- graduated winner is paused through any path (a future graduate flow, an
-- owner, a cleanup), it instantly qualifies for reactivation.
--
-- This table is the durable marker Bianca writes at crown detection and every
-- reactivation / re-test flow reads at candidate-set construction to EXCLUDE
-- the graduated adset. Writes go through the SDK chokepoint
-- [[../../docs/brain/libraries/crowned-winners]] `recordCrownedWinner` — never
-- raw `.from(...)` (CLAUDE.md § "Raw .from(...) STOP").

create table if not exists public.media_buyer_crowned_winners (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  product_id uuid references public.products(id),
  -- The crowned TEST adset (bare Meta id). This is the row identity: one
  -- crown-marker row per (workspace, test_meta_adset_id) — idempotent upsert.
  test_meta_adset_id text not null,
  -- The winning ad-grain within the crowned adset (bare Meta id), audit-trail
  -- for which creative earned the crown.
  winning_meta_ad_id text,
  crowned_at timestamptz not null default now(),
  -- Set when the graduate-crowned-winners flow moves budget onto the scaler.
  -- Null until then; graduation is out of scope for this spec (Phase 1 only
  -- persists the crown fact).
  graduated_at timestamptz,
  scaler_meta_campaign_id text,
  scaler_meta_adset_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent crown record per test adset: replaying Bianca's pass never
-- creates a duplicate row.
create unique index if not exists media_buyer_crowned_winners_ws_test_adset_key
  on public.media_buyer_crowned_winners (workspace_id, test_meta_adset_id);

-- Fast reactivation-guard read: `listCrownedWinnerAdsetIds` filters by
-- workspace + optional meta_ad_account, then returns test_meta_adset_id.
create index if not exists media_buyer_crowned_winners_ws_account_idx
  on public.media_buyer_crowned_winners (workspace_id, meta_ad_account_id);

create or replace function public.media_buyer_crowned_winners_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_crowned_winners_touch_updated_at on public.media_buyer_crowned_winners;
create trigger media_buyer_crowned_winners_touch_updated_at
  before update on public.media_buyer_crowned_winners
  for each row execute function public.media_buyer_crowned_winners_touch_updated_at();

alter table public.media_buyer_crowned_winners enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'media_buyer_crowned_winners'
      and policyname = 'media_buyer_crowned_winners_select'
  ) then
    create policy media_buyer_crowned_winners_select on public.media_buyer_crowned_winners for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'media_buyer_crowned_winners'
      and policyname = 'media_buyer_crowned_winners_service'
  ) then
    create policy media_buyer_crowned_winners_service on public.media_buyer_crowned_winners for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
