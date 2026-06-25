-- fleet_budgets: per-kind / per-function spend ceilings for the box agent fleet.
-- Phase 1 of docs/brain/specs/fleet-spend-governor.md (M4 of grow-surface-platform-agent-team).
-- A budget is a SURFACED GUARDRAIL, not a kill-switch — Phase 2 reads these vs. the
-- fleet-cost rollup and ESCALATES on a trending overrun (per the north star: an
-- autonomous tool that hits its rail routes UP to its supervisor, never auto-throttles).
--
-- Keyed per agent_jobs.kind OR per owner_function (org-chart function from
-- ownerFunctionForKind) — exactly one of the two columns is set per row. Window units
-- match docs/brain/libraries/fleet-cost.ts: TOKEN ceilings (the honest Max-lane proxy)
-- + USD-cents ceilings (only meaningful where a row is genuinely API-billed). Either
-- ceiling may be NULL — a budget with neither set is a no-op (intentionally allowed so
-- a row can be parked while the owner re-tunes).
--
-- Owner-editable: a workspace member can SELECT (RLS); writes go through the service-
-- role (createAdminClient) from the Phase 2 governor admin surface, never client-side.

create table if not exists public.fleet_budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  -- Exactly ONE of (kind, owner_function) is set. A `kind` budget caps one agent_jobs
  -- lane (e.g. 'build', 'spec-chat'); a `function` budget caps the whole org-chart
  -- function's fleet spend (e.g. 'platform' — covers every kind ownerFunctionForKind
  -- maps to platform). The Phase 2 governor reads both axes off the fleet-cost rollup.
  kind text,
  owner_function text,
  -- Window in DAYS over which spend is summed. 1 = daily, 7 = weekly. Default 7 to
  -- match the rollupFleetCost default and absorb day-to-day spikiness.
  window_days integer not null default 7
    check (window_days > 0 and window_days <= 90),
  -- Token ceiling for the window — the honest Max-lane proxy (input + output + cache).
  -- Null = no token guardrail on this row (e.g. an API-only budget).
  token_ceiling bigint check (token_ceiling is null or token_ceiling > 0),
  -- USD ceiling in CENTS for the window — meaningful only where genuinely API-billed
  -- rows contribute (rollupFleetCost's `usd_cents`). Null = no $ guardrail (the Max-
  -- lane default, since a subscription has no per-token bill).
  usd_ceiling_cents numeric check (usd_ceiling_cents is null or usd_ceiling_cents > 0),
  notes text,
  -- Owner who last edited (workspace_members.user_id) — best-effort attribution,
  -- nullable so the seeded defaults can land with no editor.
  updated_by uuid references public.workspace_members(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one of (kind, owner_function) must be set — never both, never neither.
  constraint fleet_budgets_scope_xor check (
    (kind is not null and owner_function is null) or
    (kind is null and owner_function is not null)
  )
);

-- One budget per (workspace, kind) and per (workspace, owner_function). The unique
-- index uses coalesce so NULL doesn't defeat dedup (a global default has
-- workspace_id=NULL → coalesced to a sentinel uuid).
create unique index if not exists fleet_budgets_kind_uniq
  on public.fleet_budgets (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), kind)
  where kind is not null;
create unique index if not exists fleet_budgets_function_uniq
  on public.fleet_budgets (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), owner_function)
  where owner_function is not null;

-- updated_at auto-bump on any UPDATE (the owner-editable surface relies on this).
create or replace function public.fleet_budgets_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists fleet_budgets_touch_updated_at on public.fleet_budgets;
create trigger fleet_budgets_touch_updated_at
  before update on public.fleet_budgets
  for each row execute function public.fleet_budgets_touch_updated_at();

alter table public.fleet_budgets enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'fleet_budgets' and policyname = 'fleet_budgets_select') then
    create policy fleet_budgets_select on public.fleet_budgets for select
      using (workspace_id is null or workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'fleet_budgets' and policyname = 'fleet_budgets_service') then
    create policy fleet_budgets_service on public.fleet_budgets for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

-- Seed sensible global defaults (workspace_id = NULL). All ceilings expressed in
-- TOKENS for the 7-day window (the Max-lane proxy). Per-kind defaults reflect each
-- lane's expected cadence + turn size; per-function defaults envelope the sum of
-- their kinds with headroom. A workspace can override by inserting its own row with
-- workspace_id set — the Phase 2 governor reads the most-specific row available.
--
-- Numbers are GUARDRAILS, owner-tunable. A 7-day rollup of multi-million tokens per
-- day on the busiest lanes (build / repair / spec-test) is the order of magnitude;
-- the governor escalates on a TREND over, not a single noisy day.
insert into public.fleet_budgets (workspace_id, kind, owner_function, window_days, token_ceiling, usd_ceiling_cents, notes)
values
  -- Per-kind ceilings (the Control Tower agent-kind lanes).
  (null, 'build',                  null, 7, 200000000, null, 'Default 7d token ceiling for the build lane (spec → PR feature builds).'),
  (null, 'plan',                   null, 7,  50000000, null, 'Default 7d token ceiling for the plan lane (goal-decomposition).'),
  (null, 'fold',                   null, 7,  30000000, null, 'Default 7d token ceiling for the fold lane (spec → brain folds).'),
  (null, 'spec-chat',              null, 7,  40000000, null, 'Default 7d token ceiling for the spec-chat lane (roadmap authoring turns).'),
  (null, 'spec-test',              null, 7,  80000000, null, 'Default 7d token ceiling for the spec-test lane (non-destructive QA passes).'),
  (null, 'repair',                 null, 7, 100000000, null, 'Default 7d token ceiling for the repair lane (Control Tower triage).'),
  (null, 'regression',             null, 7,  60000000, null, 'Default 7d token ceiling for the regression lane (spec-test failure review).'),
  (null, 'triage-escalations',     null, 7,  40000000, null, 'Default 7d token ceiling for the escalation triage sweep.'),
  (null, 'migration-fix',          null, 7,  30000000, null, 'Default 7d token ceiling for the migration-fix lane (billing repair).'),
  (null, 'ticket-improve',         null, 7,  30000000, null, 'Default 7d token ceiling for the ticket-improve lane (CX co-pilot turns).'),
  (null, 'product-seed',           null, 7,  60000000, null, 'Default 7d token ceiling for the product-seed lane (none → published).'),
  (null, 'dev-ask',                null, 7,  20000000, null, 'Default 7d token ceiling for the dev-ask lane (read-only dev turns).'),
  (null, 'pr-resolve',             null, 7,  40000000, null, 'Default 7d token ceiling for the pr-resolve lane (webhook-fired conflict resolver).'),
  (null, 'security-review',        null, 7,  40000000, null, 'Default 7d token ceiling for the security-review lane (post-merge supervisor).'),
  (null, 'coverage-register',      null, 7,  20000000, null, 'Default 7d token ceiling for the coverage-register lane.'),
  (null, 'storefront-optimizer',   null, 7,  40000000, null, 'Default 7d token ceiling for the storefront-optimizer lane.'),
  -- Per-function envelopes (org-chart functions owning agent lanes).
  (null, null, 'platform',  7, 600000000, null, 'Default 7d token envelope for the platform function (build/plan/fold/spec-chat/spec-test/repair/regression/pr-resolve/security-review/coverage-register/dev-ask).'),
  (null, null, 'cs',        7,  80000000, null, 'Default 7d token envelope for the cs function (ticket-improve + triage-escalations).'),
  (null, null, 'cmo',       7,  80000000, null, 'Default 7d token envelope for the cmo function (product-seed).'),
  (null, null, 'growth',    7,  60000000, null, 'Default 7d token envelope for the growth function (storefront-optimizer).'),
  (null, null, 'retention', 7,  40000000, null, 'Default 7d token envelope for the retention function (migration-fix).')
on conflict do nothing;
