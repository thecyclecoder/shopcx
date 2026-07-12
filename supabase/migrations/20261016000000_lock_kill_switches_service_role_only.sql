-- monitor-cadence-scaled-liveness-window Phase 3 (Fix 1) — lock kill_switches +
-- node_ancestry to service_role reads only.
--
-- The original migrations 20261013000000_kill_switches.sql and
-- 20261014000000_kill_switch_enforce_claim.sql shipped a broad
-- `for select to authenticated using (auth.uid() is not null)` policy on both
-- tables. kill_switches carries operational state — `off_by` (audit trail) and
-- a free-text `reason` — that should not be visible to every authenticated
-- session; the read surface belongs to the owner-gated Control Tower API. This
-- migration drops those `_select` policies so only the service_role policy
-- (already in place on both tables via `for all to service_role using (true)
-- with check (true)`) grants direct table access.
--
-- No dashboard reads either table directly today: every reader in src/ uses
-- `createAdminClient()` (service_role). If a future dashboard needs switch
-- state, it must go through the CEO-gated Control Tower switch route
-- (`POST /api/developer/control-tower/switch` and any read peer added there),
-- never a client-side `.from('kill_switches')`.
--
-- Idempotent: `drop policy if exists` — safe to re-apply.

drop policy if exists kill_switches_select on public.kill_switches;
drop policy if exists node_ancestry_select on public.node_ancestry;
