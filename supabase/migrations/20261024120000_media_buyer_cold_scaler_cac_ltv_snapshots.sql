-- bianca-cold-scaler-campaign-cac-ltv-sensor Phase 1 — the campaign-scoped
-- CAC:LTV snapshot ledger for the M4 cold scaler surface. One row per
-- (workspace, cold_scaler_cohort, iso_week) persisting the numerator (LTV
-- cents, revenue-weighted across the products the scaler advertised) and
-- denominator (scaler-scope spend + new-customer count from
-- meta_attribution_daily filtered to the scaler campaign's meta_ad_ids), the
-- derived cac_ltv_ratio + payback_days, the band (red|yellow|green|unknown),
-- and the human-readable flags carried over from
-- blendedCacLtvFromTotals so a red band shows WHY without re-derivation.
--
-- Rationale (spec Phase 1): the per-creative ROAS grader in
-- [[../../docs/brain/libraries/media-buyer-grader]] cannot see the scaler's
-- CAC:LTV (its grain is a per-creative test row from meta_attribution_daily,
-- not a whole scaler campaign), and the workspace-blended composer in
-- [[../../docs/brain/libraries/blended-cac-ltv]] aggregates every mapped ad
-- account rather than one campaign. This row is the durable, cite-able
-- artifact the M4 arming gate reads + the CEO grades against — the promise
-- that the number is not paraphrased.
--
-- Distinct from [[media_buyer_cold_scaler_arming_authorization]] (which
-- pins the shadow→armed authorization). This table pins the CAC:LTV number
-- the authorization gate consumes. Phase 2 wires the pure sensor +
-- orchestrator + reader that write into this table; Phase 1 only lays down
-- the row shape so that work can land.
--
-- Scope axes:
--   workspace_id            — NOT NULL; every snapshot belongs to one workspace.
--   meta_ad_account_id      — NULL = workspace-wide row; non-null = per-account row (mirrors the cohort table).
--   cold_scaler_cohort_id   — NOT NULL; the specific scaler cohort being sensed.
--   iso_week                — ISO 8601 week label (`YYYY-Www`) — the CAC:LTV
--                             window is weekly, so the row is week-scoped.

create table if not exists public.media_buyer_cold_scaler_cac_ltv_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  cold_scaler_cohort_id uuid not null references public.media_buyer_cold_scaler_cohorts(id) on delete cascade,
  iso_week text not null,
  spend_cents bigint not null default 0,
  new_customers int not null default 0,
  revenue_cents bigint not null default 0,
  ltv_cents bigint not null default 0,
  cac_ltv_ratio numeric,
  payback_days numeric,
  band text not null check (band in ('red','yellow','green','unknown')),
  flags jsonb not null default '[]'::jsonb,
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One snapshot per (workspace, cold_scaler_cohort, iso_week). All three
-- columns are NOT NULL so a plain unique index is sufficient — no coalesce
-- fold is needed. Re-evaluation within the same iso_week upserts on this
-- key so the newest evaluation wins (updated_at bumps via the trigger).
create unique index if not exists media_buyer_cold_scaler_cac_ltv_snapshots_ws_cohort_week_key
  on public.media_buyer_cold_scaler_cac_ltv_snapshots
    (workspace_id, cold_scaler_cohort_id, iso_week);

create or replace function public.media_buyer_cold_scaler_cac_ltv_snapshots_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_cold_scaler_cac_ltv_snapshots_touch_updated_at on public.media_buyer_cold_scaler_cac_ltv_snapshots;
create trigger media_buyer_cold_scaler_cac_ltv_snapshots_touch_updated_at
  before update on public.media_buyer_cold_scaler_cac_ltv_snapshots
  for each row execute function public.media_buyer_cold_scaler_cac_ltv_snapshots_touch_updated_at();

alter table public.media_buyer_cold_scaler_cac_ltv_snapshots enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'media_buyer_cold_scaler_cac_ltv_snapshots'
      and policyname = 'media_buyer_cold_scaler_cac_ltv_snapshots_select'
  ) then
    create policy media_buyer_cold_scaler_cac_ltv_snapshots_select on public.media_buyer_cold_scaler_cac_ltv_snapshots for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'media_buyer_cold_scaler_cac_ltv_snapshots'
      and policyname = 'media_buyer_cold_scaler_cac_ltv_snapshots_service'
  ) then
    create policy media_buyer_cold_scaler_cac_ltv_snapshots_service on public.media_buyer_cold_scaler_cac_ltv_snapshots for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
