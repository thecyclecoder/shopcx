-- Storefront Optimizer — activation + product-scope gate (OFF by default).
-- Mirrors public.iteration_policies (the ad iteration engine's control surface):
-- the per-workspace, owner/Growth-authored policy the storefront optimizer (M4) +
-- bandit framework (M1) read read-only. With `active=false` (the default) — or a
-- product not in `product_scope` — the optimizer is PROPOSE-ONLY: it forms
-- hypotheses + surfaces what it would test, but stands up ZERO running experiments,
-- assigns zero live variants, and writes no lander changes. Flipping `active=true`
-- (+ scoping the product) is the explicit "go". The engine NEVER writes its own
-- policy — only the Growth director / human does (same split as iteration_policies).
-- See docs/brain/specs/storefront-optimizer-activation-gate.md.

create table if not exists public.storefront_optimizer_policy (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,

  -- ── the on-switch ────────────────────────────────────────────────────────────
  active boolean not null default false,             -- OFF by default ⇒ propose-only

  -- The allowlist of product_ids the optimizer may touch. Empty = NOTHING in scope
  -- (most conservative; nothing reaches a customer). The owner adds Amazing Coffee
  -- here to scope it. Every campaign-enqueue + experiment-activation checks
  -- product_id ∈ product_scope — scope is ENFORCED, not narrative.
  product_scope uuid[] not null default '{}',

  -- ── editable guardrails (the bounded proxy the agent optimizes within) ─────────
  max_concurrent_experiments int not null default 3,           -- ≤ this many running experiments at once
  min_sample_sessions int not null default 50,                 -- min attributed sessions before the bandit/guardrail acts
  holdout_pct numeric not null default 0.10 check (holdout_pct >= 0 and holdout_pct <= 1), -- sacred control band
  ltv_regression_tolerance numeric not null default 0.15,      -- LTV/sess below control by this ⇒ a regression window
  regression_windows_to_rollback int not null default 2,       -- consecutive regression windows ⇒ auto-rollback
  refund_spike_delta numeric not null default 0.10,            -- refund-rate excess over control ⇒ immediate rollback

  -- ── legibility / audit (agent-legible + agent-writable later) ──────────────────
  version int not null default 1,                    -- bumped on each authored edit (Growth Director legibility)
  created_by text not null default 'human' check (created_by in ('agent', 'human')),
  rationale text,                                    -- why the current settings (supervisability)
  activated_by uuid references auth.users(id) on delete set null, -- who flipped active=true
  activated_at timestamptz,                          -- when active was last flipped true

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── RLS: members read their workspace; service role full ─────────────────────────
alter table public.storefront_optimizer_policy enable row level security;
drop policy if exists storefront_optimizer_policy_select on public.storefront_optimizer_policy;
create policy storefront_optimizer_policy_select on public.storefront_optimizer_policy
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists storefront_optimizer_policy_service on public.storefront_optimizer_policy;
create policy storefront_optimizer_policy_service on public.storefront_optimizer_policy
  for all to service_role using (true) with check (true);
