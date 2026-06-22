-- Storefront Optimizer — activation + product-scope gate (OFF by default).
--
-- The control surface for the Storefront Optimizer agent (M4) — the on-switch,
-- the enforced product scope, and the editable guardrails the agent reads to bound
-- every campaign. This is the storefront analogue of `iteration_policies` (the ad
-- engine's Growth-Director control surface): agent-LEGIBLE + agent-WRITABLE (typed
-- fields, rationale, authorship) so the future Growth director operates it later —
-- but the engine READS it read-only and NEVER writes its own policy.
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
-- One row per workspace (unique workspace_id). RLS: workspace-member SELECT,
-- service-role write. Read by src/lib/storefront/optimizer-policy.ts
-- (`loadOptimizerPolicy` / `evaluateProposalGate`).

create table if not exists public.storefront_optimizer_policy (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,

  -- ── the on-switch ────────────────────────────────────────────────────────────
  -- "the agent proposes campaigns at all." Default OFF (safe for any new workspace).
  active boolean not null default false,

  -- ── enforced product scope ───────────────────────────────────────────────────
  -- Allowlist of products the optimizer may touch (→ public.products.id). Empty ⇒
  -- nothing in scope. Checked on every proposal + activation, never narrative.
  product_scope uuid[] not null default '{}',

  -- ── the later opt-in (default false) ─────────────────────────────────────────
  -- When true, REVERSIBLE levers (copy/hero/chapter) may auto-run without the
  -- per-campaign Build/Approve tap. Offer/structural levers stay gated regardless.
  auto_run_reversible boolean not null default false,

  -- ── editable guardrails (the bounded proxy the engine optimizes within) ──────
  max_concurrent_experiments int not null default 3,    -- run-wide cap on live experiments
  min_sample int not null default 200,                  -- min per-arm exposures before a decision
  holdout_pct numeric not null default 0.10,            -- sacred control band per experiment (0.10 = 10%)
  auto_rollback_ltv_tolerance numeric not null default 0.15, -- LTV-proxy regression tolerance vs control (fraction)
  auto_rollback_windows int not null default 2,         -- consecutive regressing windows before auto-rollback
  auto_rollback_refund_spike_delta numeric not null default 0.10, -- refund-rate spike over control that rolls back

  -- ── authorship / legibility (agent-writable later, human for now) ────────────
  created_by text not null default 'human' check (created_by in ('agent', 'human')),
  updated_by uuid references auth.users(id) on delete set null, -- who last edited the policy
  rationale text,                                       -- why this policy is set as it is (Growth legibility)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists storefront_optimizer_policy_active_idx
  on public.storefront_optimizer_policy (workspace_id)
  where active = true;

-- ── RLS — workspace-member SELECT, service-role write (mirror storefront_experiments) ──
alter table public.storefront_optimizer_policy enable row level security;
drop policy if exists storefront_optimizer_policy_select on public.storefront_optimizer_policy;
create policy storefront_optimizer_policy_select on public.storefront_optimizer_policy
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_optimizer_policy_service on public.storefront_optimizer_policy;
create policy storefront_optimizer_policy_service on public.storefront_optimizer_policy
  for all to service_role using (true) with check (true);

-- ── SEED — the Superfoods workspace: ON, scoped to Amazing Coffee, propose-and-approve ──
-- The optimizer is ON in propose-and-approve mode, scoped to Amazing Coffee, the
-- moment M4 ships: it proposes; the owner taps Build to approve each test. Resolved
-- from the product row so we don't hardcode a workspace id; idempotent.
insert into public.storefront_optimizer_policy
  (workspace_id, active, product_scope, auto_run_reversible, created_by, rationale)
select p.workspace_id, true, array[p.id], false, 'human',
       'Seed: optimizer ON in propose-and-approve mode, scoped to Amazing Coffee — proposes campaigns, owner taps Build to run each test.'
from public.products p
where p.id = 'ea433e56-0aa4-4b46-9107-feb11f77f533'  -- Amazing Coffee
on conflict (workspace_id) do nothing;
