-- Storefront Optimizer — activation + product-scope gate (OFF by default).
--
-- The control surface for the Storefront Optimizer agent (M4) — the on-switch,
-- the enforced product scope, and the editable guardrails the agent reads to bound
-- every campaign. The storefront analogue of `iteration_policies` (the ad engine's
-- Growth-Director control surface): agent-LEGIBLE + agent-WRITABLE (typed fields,
-- rationale, authorship) so the future Growth director operates it later — but the
-- engine READS it read-only and NEVER writes its own policy.
--
-- Governance contract (see docs/brain/specs/storefront-optimizer-activation-gate.md):
--   - `active=false` (table default) ⇒ the agent does NOT even propose (fully idle).
--     Safe for any new workspace; the optimizer is dark until an owner flips it on.
--   - `active=true` ⇒ the agent proposes campaigns, each surfaced as a `needs_approval`
--     Build/Approve card. The OWNER's tap is what runs a test — nothing touches live
--     traffic without it (propose-and-approve mode).
--   - `auto_run_reversible=true` (a later Growth-director opt-in; default false) lets
--     REVERSIBLE copy/hero/chapter levers skip the per-campaign tap. Offer / structural
--     levers stay approval-gated REGARDLESS of this flag.
--   - `product_scope` is an ENFORCED allowlist of product ids — a proposal/activation
--     for an out-of-scope product is refused in code, not just unscheduled.
--   - The GROWTH DIRECTOR (or a human) edits this row; the engine never writes it.
--
-- One row per workspace (unique index on workspace_id). RLS: workspace-member SELECT,
-- service-role write. Read by src/lib/storefront/optimizer-policy.ts
-- (`loadOptimizerPolicy` / `evaluateProposalGate`). Mirrors the type vocabulary of
-- the shipped storefront tables (storefront_ltv_reconciler / storefront_experiments):
-- integer/double precision/boolean/jsonb/text/uuid, separate unique index, public.* refs.

-- ── CONVERGENCE (see spec ⚠️ Phase 1 BLOCKED) ────────────────────────────────
-- A prior partial apply left a STALE table in prod with only 10 of 16 columns and
-- 0 rows. `create table if not exists` no-ops against it, so the 6 missing columns
-- (auto_run_reversible, min_sample, auto_rollback_*, updated_by) are never added and
-- the seed dies (`insert ... auto_run_reversible` → column does not exist), so the
-- apply can NEVER converge. The table is empty + unshipped, so the spec's PREFERRED
-- fix is drop-and-recreate: the DROP heals any partial shape and the CREATE below
-- always rebuilds the full 16-column table. Idempotent + convergent on every re-run.
drop table if exists public.storefront_optimizer_policy;

create table if not exists public.storefront_optimizer_policy (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- ── the on-switch ────────────────────────────────────────────────────────────
  -- "the agent proposes campaigns at all." Default OFF (safe for any new workspace).
  active boolean not null default false,

  -- ── enforced product scope ───────────────────────────────────────────────────
  -- Allowlist of product ids (→ public.products.id, as a jsonb array of uuid strings)
  -- the optimizer may touch. Empty ⇒ nothing in scope. Checked on every proposal +
  -- activation, never narrative. jsonb (not uuid[]) to match the shipped storefront tables.
  product_scope jsonb not null default '[]'::jsonb,

  -- ── the later opt-in (default false) ─────────────────────────────────────────
  -- When true, REVERSIBLE levers (copy/hero/chapter) may auto-run without the
  -- per-campaign Build/Approve tap. Offer/structural levers stay gated regardless.
  auto_run_reversible boolean not null default false,

  -- ── editable guardrails (the bounded proxy the engine optimizes within) ──────
  max_concurrent_experiments integer not null default 3,        -- run-wide cap on live experiments
  min_sample integer not null default 200,                      -- min per-arm exposures before a decision
  holdout_pct double precision not null default 0.10,           -- sacred control band per experiment (0.10 = 10%)
  auto_rollback_ltv_tolerance double precision not null default 0.15, -- LTV-proxy regression tolerance vs control (fraction)
  auto_rollback_windows integer not null default 2,             -- consecutive regressing windows before auto-rollback
  auto_rollback_refund_spike_delta double precision not null default 0.10, -- refund-rate spike over control that rolls back

  -- ── authorship / legibility (agent-writable later, human for now) ────────────
  created_by text not null default 'human' check (created_by in ('agent', 'human')),
  -- who last edited the policy (an auth.users id). Plain uuid, NOT a FK to auth.users:
  -- the pooler apply role lacks REFERENCES on the auth schema, and the shipped sibling
  -- storefront tables likewise carry no FK to auth.users.
  updated_by uuid,
  rationale text,                                               -- why this policy is set as it is (Growth legibility)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One policy row per workspace — the upsert target (separate unique index, mirroring
-- storefront_ltv_calibration_ws_key).
create unique index if not exists storefront_optimizer_policy_ws_key
  on public.storefront_optimizer_policy (workspace_id);

-- ── RLS — workspace-member SELECT, service-role write (mirror storefront_experiments) ──
alter table public.storefront_optimizer_policy enable row level security;
drop policy if exists storefront_optimizer_policy_select on public.storefront_optimizer_policy;
create policy storefront_optimizer_policy_select on public.storefront_optimizer_policy
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_optimizer_policy_service on public.storefront_optimizer_policy;
create policy storefront_optimizer_policy_service on public.storefront_optimizer_policy
  for all to service_role using (true) with check (true);

-- SEED is applied by scripts/apply-storefront-optimizer-policy-migration.ts as a
-- separate, guarded step (so the critical table DDL is never coupled to the data
-- seed): the Superfoods workspace → active=true, product_scope=[amazing-coffee],
-- auto_run_reversible=false (ON in propose-and-approve mode, scoped to Amazing
-- Coffee). Idempotent (on conflict (workspace_id) do nothing).
