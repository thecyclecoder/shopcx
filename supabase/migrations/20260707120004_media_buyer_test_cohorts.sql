-- media_buyer_test_cohorts: the "test ad set" designation for the Media Buyer agent
-- (media-buyer-test-winner-loop Phase 1). One row per (workspace, meta_ad_account)
-- marking exactly ONE Meta ad set as the "test cohort" the Media Buyer is allowed
-- to publish live into, plus a per-day USD ceiling that caps that ad set's spend.
--
-- The Phase 1 publish path (src/lib/inngest/ad-tool.ts adToolPublishToMeta + the
-- publish route) refuses to flip an origin='media-buyer-test' ad to ACTIVE unless
-- (a) the chosen meta_adset_id matches this cohort row's test_meta_adset_id AND
-- (b) the resulting daily_budget on that ad set stays within daily_test_ceiling_cents.
-- Over-ceiling / wrong-adset → publish PAUSED + escalate to the CEO (north star:
-- hit a rail = escalate, not execute).
--
-- Distinct from ad_spend_budgets (the ROLLING-WINDOW ad-DOLLAR ceiling read by
-- ad-spend-governor). This table is the DAILY test-cohort configuration read at
-- PUBLISH time — the entry rail for the autonomous go-live, not the standing
-- supervisor's leash.

create table if not exists public.media_buyer_test_cohorts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  test_meta_adset_id text not null,
  daily_test_ceiling_cents bigint not null check (daily_test_ceiling_cents > 0),
  is_active boolean not null default true,
  notes text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active cohort per (workspace, meta_ad_account) — a workspace with multiple
-- ad accounts can hold one test cohort per account. NULL meta_ad_account_id caps
-- the workspace as a whole (used when a workspace has one connected ad account).
create unique index if not exists media_buyer_test_cohorts_ws_account_active_key
  on public.media_buyer_test_cohorts (workspace_id, coalesce(meta_ad_account_id::text, ''))
  where is_active = true;

create or replace function public.media_buyer_test_cohorts_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_test_cohorts_touch_updated_at on public.media_buyer_test_cohorts;
create trigger media_buyer_test_cohorts_touch_updated_at
  before update on public.media_buyer_test_cohorts
  for each row execute function public.media_buyer_test_cohorts_touch_updated_at();

alter table public.media_buyer_test_cohorts enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_test_cohorts' and policyname = 'media_buyer_test_cohorts_select') then
    create policy media_buyer_test_cohorts_select on public.media_buyer_test_cohorts for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_test_cohorts' and policyname = 'media_buyer_test_cohorts_service') then
    create policy media_buyer_test_cohorts_service on public.media_buyer_test_cohorts for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

-- ad_publish_jobs.origin: the CALLER of a publish job. NULL / 'operator' → the
-- studio/human path (unchanged). 'media-buyer-test' → the Media Buyer agent's
-- autonomous publish path (subject to the media_buyer_test_cohorts gate above).
-- Other origins (Iteration Engine 6b, etc.) may land in the future.
alter table public.ad_publish_jobs
  add column if not exists origin text;
