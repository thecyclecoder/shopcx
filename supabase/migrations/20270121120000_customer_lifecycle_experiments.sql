-- customer_lifecycle_experiments + customer_lifecycle_experiment_assignments —
-- the person-level experiment spine for the self-running pre-renewal-reminder 50/50 test
-- ([[subscriber-experiment-harness]] spec, Phase 1; goal pre-renewal-reminder-next-order-journey
-- M3 "Self-running 50/50 test"). This is a NEW harness, deliberately NOT storefront_experiments:
-- that framework is visitor/render grain with content-patch variants
-- ([[storefront_experiments]]), the wrong grain (visitor, not person) and the wrong lever
-- (content, not send/no-send) for a subscriber messaging test.
--
-- Two tables:
--   1. customer_lifecycle_experiments — one row per experiment, carrying its proxy metric,
--      holdout share, the PRE-REGISTERED sample size (power calc) and the stop rule, so the
--      downstream verdict reads a fixed N decided BEFORE launch rather than after seeing data.
--   2. customer_lifecycle_experiment_assignments — exactly one persisted arm per customer
--      identity GROUP per experiment. Keyed on the customer_links group_id ([[customer_links]])
--      — one real person, several linked accounts, ONE arm. The UNIQUE (experiment_id, group_id)
--      constraint is what makes assignment sticky + idempotent + fixed-at-first-eligibility: an
--      arm can never be duplicated or silently flipped once written.
--
-- RLS: service-role only. Every read/write goes through the src/lib/subscriber-experiments.ts
-- SDK under the service role (CLAUDE.md: all writes via createAdminClient; raw .from STOP rule).

create table if not exists public.customer_lifecycle_experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- stable human slug for the experiment (e.g. 'pre-renewal-reminder'). The SDK resolves an
  -- experiment by (workspace_id, slug).
  slug text not null,
  -- lifecycle status. Derived nowhere — an explicit operator lifecycle column.
  --   draft    — created, not yet assigning
  --   running  — actively assigning + sending
  --   stopped  — kill-switched / halted (the stop rule tripped or an operator paused it)
  --   complete — the verdict is in
  status text not null default 'draft' check (status in ('draft', 'running', 'stopped', 'complete')),
  -- the primary success metric this test is powered to move, e.g. '90d_net_revenue_per_customer'.
  proxy_metric text not null default '90d_net_revenue_per_customer',
  -- arm config — the share (0..100) of identity groups routed to the TRUE holdout; the remainder
  -- goes to treatment. A 50/50 test with a real holdout is holdout_pct = 50.
  holdout_pct numeric not null default 50 check (holdout_pct >= 0 and holdout_pct <= 100),
  -- ── Pre-registered power calculation (written down BEFORE launch) ──
  -- the target minimum detectable effect as a relative lift on proxy_metric (e.g. 0.05 = 5%).
  target_mde numeric,
  -- statistical power (1 - beta), e.g. 0.8.
  power numeric,
  -- significance level (alpha), e.g. 0.05.
  alpha numeric,
  -- the assumed baseline coefficient of variation of proxy_metric, feeding the power calc.
  baseline_cv numeric,
  -- the pre-registered REQUIRED sample size PER ARM (output of the power calc). The downstream
  -- verdict reads THIS fixed N, never decides N after seeing data.
  required_n_per_arm integer,
  -- the pre-registered stop rule — free-text / structured description of when the test ends.
  stop_rule text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create index if not exists customer_lifecycle_experiments_workspace_idx
  on public.customer_lifecycle_experiments (workspace_id);

create table if not exists public.customer_lifecycle_experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  experiment_id uuid not null references public.customer_lifecycle_experiments(id) on delete cascade,
  -- the customer identity GROUP id from public.customer_links ([[customer_links]]). One real
  -- person = one group_id across all their linked accounts, so every account shares ONE arm.
  -- For an unlinked customer the group_id is the customer's own id (its singleton group).
  group_id uuid not null,
  -- the permanent arm — 'treatment' (gets the reminder) or 'holdout' (gets nothing new).
  arm text not null check (arm in ('treatment', 'holdout')),
  assigned_at timestamptz not null default now(),
  -- STICKY + IDEMPOTENT + FIXED-AT-FIRST-ELIGIBILITY: one assignment per group per experiment,
  -- never duplicated, never flipped.
  unique (experiment_id, group_id)
);

create index if not exists customer_lifecycle_experiment_assignments_experiment_idx
  on public.customer_lifecycle_experiment_assignments (experiment_id);

alter table public.customer_lifecycle_experiments enable row level security;
drop policy if exists customer_lifecycle_experiments_service on public.customer_lifecycle_experiments;
create policy customer_lifecycle_experiments_service on public.customer_lifecycle_experiments
  for all to service_role using (true) with check (true);

alter table public.customer_lifecycle_experiment_assignments enable row level security;
drop policy if exists customer_lifecycle_experiment_assignments_service on public.customer_lifecycle_experiment_assignments;
create policy customer_lifecycle_experiment_assignments_service on public.customer_lifecycle_experiment_assignments
  for all to service_role using (true) with check (true);
