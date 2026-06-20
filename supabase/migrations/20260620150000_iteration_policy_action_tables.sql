-- Storefront Iteration Engine — Phase 4c: Policy + action ledger tables.
--
-- The Growth Director's control surface (`iteration_policies`) + the engine's
-- audit / idempotency / reversal substrate (`iteration_actions`). Both are
-- agent-legible + agent-writable (typed fields, rationale, authorship, versioning)
-- so the future AI Growth Director can operate them with NO migration.
--
-- Governance contract (see spec § Governance model):
--   - The ENGINE reads `iteration_policies` (active version) read-only and never
--     writes it; it appends/updates `iteration_actions` only.
--   - The GROWTH DIRECTOR (or a human) authors new `iteration_policies` versions
--     with a rationale; activating one supersedes the prior active version.
--   - With NO active policy version the engine takes ZERO autonomous actions
--     (the core safety invariant — enforced in code by loadActivePolicy).
--
-- Read by src/lib/meta/decision-engine.ts (`loadActivePolicy` /
-- `loadRecentActions`); `iteration_actions` is appended/updated by the Phase 5
-- cron + Phase 6a adapters (`persistActions`). Monetary fields are minor units
-- (cents) of the account currency.
-- See docs/brain/specs/storefront-iteration-engine.md (Phase 4c).

-- ── iteration_policies — the versioned control surface (read-only to the engine) ─
create table if not exists public.iteration_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- Reserved scoping. Global in v1: both null ⇒ the policy applies to the whole
  -- workspace. A non-null campaign_id (and/or account) is a future per-object
  -- override the engine can honor with NO migration.
  meta_ad_account_id uuid references public.meta_ad_accounts(id) on delete cascade,
  campaign_id text,                                  -- per-campaign override (reserved; null = global)

  version int not null,                              -- monotonically increasing per workspace scope
  status text not null default 'pending' check (status in ('pending', 'active', 'superseded')),
  created_by text not null default 'human' check (created_by in ('agent', 'human')),
  rationale text,                                    -- why this version exists (Growth Director legibility)

  -- ── typed thresholds (the editable proxy bounds the engine optimizes within) ──
  roas_floor numeric not null,                       -- ROAS below which an object underperforms
  scale_up_roas_trigger numeric not null,            -- ROAS at/above which to scale up
  scale_up_step_pct numeric not null,                -- per-step budget increase (e.g. 0.20)
  scale_up_cap_pct numeric not null,                 -- max single-step increase
  scale_down_step_pct numeric not null,              -- budget reduction on underperformance
  pause_min_spend_cents bigint not null,             -- min window spend before pause is eligible
  pause_window_days int not null,                    -- window the pause trigger evaluates
  unpause_sales_after_pause bigint not null,         -- sales (cents) since pause to consider unpausing
  unpause_lookback_days int not null,                -- how far back to look for the pause + sales
  min_creatives_per_adset int not null,              -- replenish trigger
  per_object_cooldown_hours int not null,            -- min hours between actions on one object
  per_account_daily_budget_delta_ceiling_cents bigint not null, -- run-wide budget-change ceiling

  -- ── guardrails (degenerate-state stops; hitting one ESCALATES, never executes) ─
  min_budget_floor_cents bigint,                     -- never scale an object below this (null = no floor)
  never_pause_object_ids text[] not null default '{}', -- never fully pause these objects

  -- ── activation audit ─────────────────────────────────────────────────────────
  activated_by uuid references auth.users(id) on delete set null,
  activated_at timestamptz,
  superseded_by uuid references public.iteration_policies(id) on delete set null,
  superseded_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One version number per global (campaign-less) policy line per workspace.
create unique index if not exists iteration_policies_version_idx
  on public.iteration_policies (workspace_id, version)
  where campaign_id is null;

-- At most ONE active global policy per workspace (activating supersedes the prior).
create unique index if not exists iteration_policies_one_active_idx
  on public.iteration_policies (workspace_id)
  where status = 'active' and campaign_id is null;

create index if not exists iteration_policies_workspace_status_idx
  on public.iteration_policies (workspace_id, status, version);

-- ── iteration_actions — the append/update ledger of autonomous decisions ─────────
create table if not exists public.iteration_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  snapshot_date date not null,                       -- the scorecard day this was decided on
  level text not null check (level in ('adset', 'campaign')),
  object_id text not null,                           -- Meta adset/campaign id acted on
  label text,                                        -- human-legible object name at decision time
  action_type text not null check (action_type in (
    'pause', 'unpause', 'scale_up', 'scale_down', 'replenish_creative'
  )),
  rationale text not null,                           -- surfaced reasoning: trigger + policy rule invoked

  -- ── provenance (every action cites its authority + trigger) ───────────────────
  policy_version_id uuid references public.iteration_policies(id) on delete set null,
  triggering_scorecard_id uuid references public.iteration_scorecards_daily(id) on delete set null,

  -- ── before / after (for execution + reversal) ────────────────────────────────
  before_budget_cents bigint,
  before_status text,
  after_budget_cents bigint,
  after_status text,

  -- ── execution state ──────────────────────────────────────────────────────────
  -- decided   : 4a decided it; not yet executed (Phase 6a executes)
  -- executed  : Phase 6a applied it to Meta
  -- failed    : execution errored
  -- escalated : a guardrail fired — flagged for the Growth Director, NOT executed
  -- reversed  : a later run reverted this action
  status text not null default 'decided' check (status in (
    'decided', 'executed', 'failed', 'escalated', 'reversed'
  )),
  guardrail text,                                    -- which guardrail fired (escalated rows)
  external_result jsonb,                             -- Phase 6a write-back: { meta_*_id, graph_response, ... }
  executed_at timestamptz,

  -- ── outcome-after / reversal tracking ────────────────────────────────────────
  outcome_roas numeric,                              -- ROAS measured AFTER the action (reconcile stage)
  outcome_revenue_cents bigint,
  outcome_window_days int,
  outcome_evaluated_at timestamptz,
  reverses_action_id uuid references public.iteration_actions(id) on delete set null,    -- this action reverts that one
  reversed_by_action_id uuid references public.iteration_actions(id) on delete set null, -- this action was reverted by that one

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Idempotency: at most one action of a given type per object per snapshot day,
  -- so a cron re-run never double-acts (cooldown is enforced in code on top).
  unique (workspace_id, meta_ad_account_id, object_id, action_type, snapshot_date)
);

create index if not exists iteration_actions_account_created_idx
  on public.iteration_actions (workspace_id, meta_ad_account_id, created_at);
create index if not exists iteration_actions_object_created_idx
  on public.iteration_actions (workspace_id, object_id, created_at);
create index if not exists iteration_actions_account_status_idx
  on public.iteration_actions (meta_ad_account_id, status, snapshot_date);

-- ── RLS: members read their workspace; service role full ─────────────────────
alter table public.iteration_policies enable row level security;
drop policy if exists iteration_policies_select on public.iteration_policies;
create policy iteration_policies_select on public.iteration_policies
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists iteration_policies_service on public.iteration_policies;
create policy iteration_policies_service on public.iteration_policies
  for all to service_role using (true) with check (true);

alter table public.iteration_actions enable row level security;
drop policy if exists iteration_actions_select on public.iteration_actions;
create policy iteration_actions_select on public.iteration_actions
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists iteration_actions_service on public.iteration_actions;
create policy iteration_actions_service on public.iteration_actions
  for all to service_role using (true) with check (true);
