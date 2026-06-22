-- Storefront experiment + bandit framework — the on-site experimentation substrate
-- for the storefront-optimizer goal (docs/brain/specs/storefront-experiment-bandit-framework.md).
--
-- Three tables:
--   storefront_experiments         — one row per hypothesis (product × lander_type × audience × lever)
--   storefront_experiment_variants — one row per arm (control/holdout + variants), each a reversible
--                                    content PATCH over the DB-driven lander, plus Thompson-sampling
--                                    posterior state (alpha/beta, reward_sum/n) + attributed rollups
--   storefront_experiment_runs     — one row per bandit-refresh run (the supervisable audit trail)
--
-- Safety invariants baked in here:
--   • status CHECK ∈ draft|running|promoted|killed|rolled_back
--   • lander_type CHECK ∈ pdp|listicle|beforeafter|advertorial
--   • holdout_pct CHECK in [0,1]
--   • exactly one is_control arm per experiment (partial unique index)
-- RLS mirrors advertorial_pages: workspace-member SELECT, service-role write.

-- ── storefront_experiments ────────────────────────────────────────────────────
create table if not exists public.storefront_experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  lander_type text not null check (lander_type in ('pdp', 'listicle', 'beforeafter', 'advertorial')),
  audience text not null default 'all',
  lever text not null,
  hypothesis text,
  status text not null default 'draft'
    check (status in ('draft', 'running', 'promoted', 'killed', 'rolled_back')),
  holdout_pct numeric not null default 0.10 check (holdout_pct >= 0 and holdout_pct <= 1),
  -- Set when the bandit promotes a winning arm; render serves this variant to all
  -- non-holdout traffic. Null while running/draft. FK set-null so a deleted variant
  -- can't dangle the experiment.
  promoted_variant_id uuid,
  -- Phase 5 guardrail bookkeeping. regression_windows counts CONSECUTIVE windows a
  -- running/promoted variant has sat below control on the LTV proxy; auto-rollback at >=2.
  regression_windows int not null default 0,
  rollback_reason text,
  -- Last decision snapshot (posteriors + rule invoked) for supervisability.
  last_decision jsonb not null default '{}'::jsonb,
  created_by uuid,
  started_at timestamptz,
  stopped_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists storefront_experiments_ws_status_idx
  on public.storefront_experiments (workspace_id, status);
-- Render-time lookup: active experiments for a (product, lander_type).
create index if not exists storefront_experiments_render_idx
  on public.storefront_experiments (workspace_id, product_id, lander_type, status);

-- ── storefront_experiment_variants ────────────────────────────────────────────
create table if not exists public.storefront_experiment_variants (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.storefront_experiments(id) on delete cascade,
  -- Denormalized for RLS + fast funnel queries (mirrors storefront_events).
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text not null,
  is_control boolean not null default false,
  -- The reversible content patch over the DB-driven lander (copy / hero / chapter
  -- order). Empty {} on the control arm. NEVER a code deploy or an offer/pricing
  -- change (offers are M6, approval-gated). See applyVariantPatch in
  -- src/lib/storefront/experiments.ts for the supported shape.
  patch jsonb not null default '{}'::jsonb,
  -- Thompson-sampling posterior over the conversion proxy (Beta-Bernoulli).
  alpha double precision not null default 1,
  beta double precision not null default 1,
  -- Numeric-reward posterior inputs (predicted-LTV proxy sum / observation count).
  reward_sum double precision not null default 0,
  n integer not null default 0,
  -- Attributed rollups (Phase 3), recomputed idempotently each refresh.
  sessions integer not null default 0,
  conversions integer not null default 0,
  sub_attach integer not null default 0,
  revenue_cents bigint not null default 0,
  -- The predicted-LTV proxy this spec RECORDS (sub-attach × est-sub-LTV + one-time
  -- margin); M3's reconciler owns calibrating the proxy weights.
  ltv_proxy_cents bigint not null default 0,
  last_rolled_up_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists storefront_experiment_variants_experiment_idx
  on public.storefront_experiment_variants (experiment_id);
-- Holdout is sacred: exactly one control/holdout arm per experiment.
create unique index if not exists storefront_experiment_variants_one_control
  on public.storefront_experiment_variants (experiment_id) where is_control;

-- promoted_variant_id FK added after the variants table exists.
alter table public.storefront_experiments
  drop constraint if exists storefront_experiments_promoted_variant_fk;
alter table public.storefront_experiments
  add constraint storefront_experiments_promoted_variant_fk
  foreign key (promoted_variant_id)
  references public.storefront_experiment_variants(id) on delete set null;

-- ── storefront_experiment_runs ────────────────────────────────────────────────
create table if not exists public.storefront_experiment_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  trigger text not null default 'cron' check (trigger in ('cron', 'manual')),
  status text not null default 'running' check (status in ('running', 'complete', 'failed')),
  experiments_evaluated integer not null default 0,
  -- Per-experiment decision snapshots (posterior win-probabilities + the rule invoked).
  decisions jsonb not null default '[]'::jsonb,
  -- Regression rollbacks escalated to Growth this run (surface, don't bury).
  escalations jsonb not null default '[]'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  conservative boolean not null default true,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists storefront_experiment_runs_ws_idx
  on public.storefront_experiment_runs (workspace_id, started_at desc);

-- ── RLS — workspace-member SELECT, service-role write (mirror advertorial_pages) ──
alter table public.storefront_experiments enable row level security;
drop policy if exists storefront_experiments_select on public.storefront_experiments;
create policy storefront_experiments_select on public.storefront_experiments
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_experiments_service on public.storefront_experiments;
create policy storefront_experiments_service on public.storefront_experiments
  for all to service_role using (true) with check (true);

alter table public.storefront_experiment_variants enable row level security;
drop policy if exists storefront_experiment_variants_select on public.storefront_experiment_variants;
create policy storefront_experiment_variants_select on public.storefront_experiment_variants
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_experiment_variants_service on public.storefront_experiment_variants;
create policy storefront_experiment_variants_service on public.storefront_experiment_variants
  for all to service_role using (true) with check (true);

alter table public.storefront_experiment_runs enable row level security;
drop policy if exists storefront_experiment_runs_select on public.storefront_experiment_runs;
create policy storefront_experiment_runs_select on public.storefront_experiment_runs
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_experiment_runs_service on public.storefront_experiment_runs;
create policy storefront_experiment_runs_service on public.storefront_experiment_runs
  for all to service_role using (true) with check (true);
