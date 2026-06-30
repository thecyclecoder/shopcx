-- ad_spend_budgets: per-workspace ad-DOLLAR budget ceilings for the Growth director.
-- Phase 1 of docs/brain/specs/growth-ad-spend-rail.md.
--
-- Distinct from fleet_budgets (Max-lane TOKENS) and from iteration_policies
-- per_account_daily_budget_delta_ceiling_cents (per-PASS motion limit). This is the
-- ad-spend ROLLING-WINDOW ceiling: Phase 2's ad-spend-governor reads actual
-- daily_meta_ad_spend vs the ceiling on cadence and ESCALATES on a trend over
-- (per docs/brain/operational-rules.md § North star — an autonomous tool that hits
-- its rail routes UP to its supervisor, never auto-throttles).
--
-- Scope axes:
--   workspace_id        — NOT NULL; the budget is always owned by exactly one workspace.
--   platform            — 'meta' | 'google' | 'amazon'; the ad-channel envelope.
--   meta_ad_account_id  — optional override; NULL row caps the workspace+platform as a
--                         whole, a non-null row caps a single ad-account inside it.
-- getEffectiveAdSpendBudget (Phase 2) reads the most-specific row available: a row with
-- meta_ad_account_id set beats the platform-wide row for the same workspace.

create table if not exists public.ad_spend_budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  platform text not null check (platform in ('meta', 'google', 'amazon')),
  window_days integer not null default 7
    check (window_days > 0 and window_days <= 90),
  usd_ceiling_cents bigint not null check (usd_ceiling_cents > 0),
  notes text,
  -- Owner who last edited (auth.users.id) — best-effort attribution; nullable so a
  -- service-role write (e.g. seeding by a script) can land with no editor.
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at auto-bump on any UPDATE (mirrors fleet_budgets so the owner-editable
-- surface stays accurate without app-layer help).
create or replace function public.ad_spend_budgets_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ad_spend_budgets_touch_updated_at on public.ad_spend_budgets;
create trigger ad_spend_budgets_touch_updated_at
  before update on public.ad_spend_budgets
  for each row execute function public.ad_spend_budgets_touch_updated_at();

alter table public.ad_spend_budgets enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'ad_spend_budgets' and policyname = 'ad_spend_budgets_select') then
    create policy ad_spend_budgets_select on public.ad_spend_budgets for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'ad_spend_budgets' and policyname = 'ad_spend_budgets_service') then
    create policy ad_spend_budgets_service on public.ad_spend_budgets for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
