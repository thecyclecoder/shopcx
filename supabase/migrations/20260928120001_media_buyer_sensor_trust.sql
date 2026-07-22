-- media_buyer_sensor_trust: per-workspace daily sensor-trust snapshot for the
-- Media Buyer agent (media-buyer-sensor-trust-probe Phase 1). One row per
-- (workspace, meta_ad_account, snapshot_date) records whether the attribution
-- sensor was clean enough that day for the Media Buyer's shadow-mode calls to
-- trust ROAS. Phase 3 will short-circuit the runMediaBuyerLoop when the newest
-- row is missing / stale / band='red'.
--
-- Distinct from ad_spend_budgets (rolling-window DOLLAR ceiling, standing
-- supervisor) and media_buyer_test_cohorts (test-ad-set + daily ceiling, entry
-- rail). This table is a per-DAY sensor-quality signal — the input the Media
-- Buyer agent reads before deciding whether attribution numbers are worth
-- optimizing against.
--
-- Scope axes:
--   workspace_id       — NOT NULL; the snapshot always belongs to one workspace.
--   meta_ad_account_id — NULL = workspace-wide fallback; non-null = per-account.
--   snapshot_date      — one row per (workspace, account, date).
--
-- Uniqueness is enforced by a partial-expression index that folds NULL
-- meta_ad_account_id to '' so the workspace-wide row can also coexist with
-- per-account rows on the same date.

create table if not exists public.media_buyer_sensor_trust (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  snapshot_date date not null,
  window_days integer not null check (window_days > 0 and window_days <= 90),
  coverage_ratio numeric,
  unresolved_revenue_share numeric,
  spend_allocation_ratio numeric,
  sample_orders integer not null default 0 check (sample_orders >= 0),
  sample_spend_cents bigint not null default 0 check (sample_spend_cents >= 0),
  band text not null check (band in ('green', 'yellow', 'red')),
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One snapshot per (workspace, meta_ad_account, snapshot_date). NULL
-- meta_ad_account_id folds to '' so the workspace-wide row coexists with
-- per-account rows for the same date without colliding.
create unique index if not exists media_buyer_sensor_trust_ws_account_date_key
  on public.media_buyer_sensor_trust
    (workspace_id, coalesce(meta_ad_account_id::text, ''), snapshot_date);

-- updated_at auto-bump so an upsert re-write bumps the timestamp (Phase 2's
-- runSensorTrustProbe re-runs the same day are legal — the second call is an
-- upsert, not a duplicate row).
create or replace function public.media_buyer_sensor_trust_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_sensor_trust_touch_updated_at on public.media_buyer_sensor_trust;
create trigger media_buyer_sensor_trust_touch_updated_at
  before update on public.media_buyer_sensor_trust
  for each row execute function public.media_buyer_sensor_trust_touch_updated_at();

alter table public.media_buyer_sensor_trust enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_sensor_trust' and policyname = 'media_buyer_sensor_trust_select') then
    create policy media_buyer_sensor_trust_select on public.media_buyer_sensor_trust for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_sensor_trust' and policyname = 'media_buyer_sensor_trust_service') then
    create policy media_buyer_sensor_trust_service on public.media_buyer_sensor_trust for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
