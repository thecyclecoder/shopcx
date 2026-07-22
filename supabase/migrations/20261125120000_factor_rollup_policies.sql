-- factor-rollup-sdk-with-significance-gate Phase 1 — workspace-tunable significance
-- thresholds for the factor-rollup SDK (per-{theme, angle, pattern, combination}
-- CPA/CTR/ROAS rollups the M5 close-loop spec re-weights the selection engine with).
--
-- The gate cannot be a magic number in code: a Superfoods-scale workspace's
-- "meaningful" spend is different from a small brand's, and a two-purchase win-rate
-- must never crown an angle. Mirrors the shipped [[../../src/lib/ads/testing-results-sdk.ts]]
-- `resolveTestThresholds` → `iteration_policies` pattern: one row per workspace,
-- nullable knobs, code-owned defaults, an idempotent resolver. Consumers query the
-- resolver (never this table raw) via
-- [[../../src/lib/ads/factor-rollup-policies.ts]] `resolveFactorRollupThresholds`.
--
-- No versioning here (unlike iteration_policies): the factor-rollup gate is a
-- workspace-wide TUNING knob, not a policy-authoring surface — one row per
-- workspace, in-place edits, RLS-gated to workspace members + service-role.
-- See docs/brain/specs/factor-rollup-sdk-with-significance-gate.md Phase 1.

create table if not exists public.factor_rollup_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,

  -- Minimum window spend (cents) a factor bucket must hit before its CPA/CTR/ROAS
  -- can pass the significance gate. Null = fall through to the resolver's code
  -- default (see DEFAULT_FACTOR_ROLLUP_THRESHOLDS in factor-rollup-policies.ts).
  min_spend_cents bigint check (min_spend_cents is null or min_spend_cents >= 0),

  -- Minimum purchases in the window before a factor bucket can pass the gate.
  -- Null = fall through to the resolver's code default. Guards against
  -- two-purchase win-rates crowning an angle.
  min_purchases int check (min_purchases is null or min_purchases >= 0),

  -- Confidence knob (0..1) reserved for the follow-on statistical-gate work
  -- (the goal names three axes: spend / purchases / confidence). Held as a
  -- nullable soft tunable so the shipped resolver returns it verbatim; today's
  -- gate is spend + purchases only.
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at auto-bump on any UPDATE (owner-editable tuning knob).
create or replace function public.factor_rollup_policies_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists factor_rollup_policies_touch_updated_at on public.factor_rollup_policies;
create trigger factor_rollup_policies_touch_updated_at
  before update on public.factor_rollup_policies
  for each row execute function public.factor_rollup_policies_touch_updated_at();

-- ── RLS: workspace-member SELECT, service-role full (mirrors iteration_policies) ──
alter table public.factor_rollup_policies enable row level security;

drop policy if exists factor_rollup_policies_select on public.factor_rollup_policies;
create policy factor_rollup_policies_select on public.factor_rollup_policies
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists factor_rollup_policies_service on public.factor_rollup_policies;
create policy factor_rollup_policies_service on public.factor_rollup_policies
  for all to service_role using (true) with check (true);
