-- agent_model_tiers — the per-agent model-tier registry (box-agent-model-tiers spec, Phase 1).
--
-- Every box `claude -p` agent (the org-chart workers Bo/build, Rafa/repair, Fenn/fold … AND the
-- director Ada) runs with NO --model flag today, so they all inherit the one Max-plan default model.
-- This table is the LOCKED config that lets the box put a given agent kind on a specific tier:
-- one row per (workspace_id, agent_kind) maps a kind → a model tier (haiku｜sonnet｜opus). The box
-- reads it per claimed job and passes `--model <resolved id>` (resolved through src/lib/ai-models.ts
-- MODELS). An UNSET kind (no row, or model_tier null) ⇒ no --model flag ⇒ the Max default — so an
-- unset kind never regresses (today's behavior).
--
-- The Max nuance: box agents run on the Max subscription with ANTHROPIC_API_KEY stripped → $0
-- marginal per token. A smaller tier is NOT a dollar saving — its value is speed + less 5-hour
-- usage-window pressure. Reserve the big model for quality-critical agents; put mechanical,
-- high-volume agents (fold/monitor/coverage-register) on a smaller, faster tier.
--
-- Governance (Phase 3): a tier changes ONLY through the director→supervisor proposal flow, never a
-- silent edit. proposed_by / approved_by record the org-chart functions that proposed and approved
-- the current value (auditable, mirrors the approval_decisions ledger). Reversible — flip the row
-- back — so it is a low-risk, in-leash config change with no deploy.
--
-- Workspace-scoped (mirrors agent_jobs / approval_decisions — the tier belongs to the workspace whose
-- agents it governs). RLS: any authenticated user reads (the Agents hub is owner-gated above the DB);
-- service role does all writes (the box resolver reads; the proposal-apply path writes).

create table if not exists public.agent_model_tiers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the agent kind this tier governs — matches agent_jobs.kind (build｜repair｜fold｜…). Free text
  -- (not an enum) so a new agent kind can be tiered without a migration.
  agent_kind text not null,
  -- the model tier: haiku｜sonnet｜opus. NULL ⇒ unset ⇒ the box passes no --model (the Max default).
  model_tier text check (model_tier in ('haiku', 'sonnet', 'opus')),
  -- the org-chart function that PROPOSED the current value (the director seat, or 'seed' for the
  -- Phase-2 starting tiers). Auditable provenance, paired with approval_decisions.
  proposed_by text,
  -- the org-chart function that APPROVED the current value (the supervisor seat / 'ceo' / 'seed').
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- one tier per kind per workspace — the upsert key the resolver + the proposal-apply path use.
  unique (workspace_id, agent_kind)
);

-- The resolver read: a workspace's tier for one kind (the box's per-claimed-job lookup).
create index if not exists agent_model_tiers_ws_kind_idx
  on public.agent_model_tiers (workspace_id, agent_kind);

alter table public.agent_model_tiers enable row level security;
drop policy if exists agent_model_tiers_select on public.agent_model_tiers;
create policy agent_model_tiers_select on public.agent_model_tiers
  for select to authenticated using (auth.uid() is not null);
drop policy if exists agent_model_tiers_service on public.agent_model_tiers;
create policy agent_model_tiers_service on public.agent_model_tiers
  for all to service_role using (true) with check (true);
