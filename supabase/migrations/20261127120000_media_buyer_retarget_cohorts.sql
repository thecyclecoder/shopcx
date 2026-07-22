-- media_buyer_retarget_cohorts: the "retarget campaign" designation for the Media Buyer
-- agent's THIRD Meta campaign (retarget-campaign-warm-hot-mixed-content Phase 1).
--
-- Distinct from public.media_buyer_test_cohorts (the COLD test rail Bianca's replenish loop
-- runs). That table stands up per-test $150 cold ad sets under a testing campaign; THIS table
-- stands up ONE lean consolidated retarget ad set under a dedicated retarget campaign, carrying
-- WARM + HOT MIXED creative (sourced from creatives Dahlia tags `warm`/`hot`). One row per
-- (workspace, meta_ad_account, product) marks the single consolidated retarget ad set the
-- retarget replenish loop is allowed to publish live into, plus a per-day USD ceiling that
-- caps that ad set's spend.
--
-- The retarget publish path (src/lib/media-buyer/retarget-publish-gate.ts
-- evaluateMediaBuyerRetargetPublish) refuses to flip a retarget ad ACTIVE unless (a) the chosen
-- meta_adset_id matches this cohort row's retarget_meta_adset_id (the ONE consolidated adset) AND
-- (b) the resulting daily budget stays within daily_ceiling_cents AND (c) the creative clears the
-- shared 9/10 Max copy-QC floor. A breach → publish PAUSED + escalate to the CEO (north star: hit
-- a rail = escalate, not execute).
--
-- The cold-only invariant of Bianca's existing replenish loop is UNTOUCHED — the retarget rail
-- reads warm+hot creatives from its own whitelist and never feeds the cold test cohort.

create table if not exists public.media_buyer_retarget_cohorts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  product_id uuid references public.products(id),
  retarget_meta_campaign_id text not null,
  retarget_meta_adset_id text not null,
  daily_ceiling_cents bigint not null check (daily_ceiling_cents > 0),
  audience_temperatures text[] not null default '{warm,hot}',
  is_active boolean not null default true,
  notes text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active retarget cohort per (workspace, meta_ad_account, product) — a shared account can hold
-- both a null-product default AND one active row per product simultaneously. NULL meta_ad_account_id
-- caps the workspace as a whole (used when a workspace has one connected ad account).
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
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_retarget_cohorts' and policyname = 'media_buyer_retarget_cohorts_select') then
    create policy media_buyer_retarget_cohorts_select on public.media_buyer_retarget_cohorts for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_retarget_cohorts' and policyname = 'media_buyer_retarget_cohorts_service') then
    create policy media_buyer_retarget_cohorts_service on public.media_buyer_retarget_cohorts for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
