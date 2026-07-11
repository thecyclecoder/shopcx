-- kill_switches — the universal on/off primitive behind the CEO control-tower switch
-- ([[kill-switches-table-and-cascade-resolver]] spec, Phase 1). One row per node the CEO has
-- explicitly turned OFF; a missing row means the node is ON (fail-open — an unconfigured
-- registry never silently switches a node off). The Phase 2 resolveEffectiveSwitch cascade
-- walks the canonical node registry ([[control-tower-node-registry]]) parent→parent so an
-- ancestor-off node cascades down to every descendant.
--
-- GLOBAL config (one row per canonical node_id) — the org chart is ShopCX's own internal
-- DevOps org, singular; this is not per-tenant data, so there is no workspace_id. The
-- node_id is the PK and MUST match a node emitted by resolveNodeOwner in the canonical
-- registry (validated by the Phase 3 API route above the DB).
-- RLS: any authenticated user reads (dashboards show the current switch state); service
-- role does writes. The Phase 3 POST /api/developer/control-tower/switch route is the
-- ONLY writer — it gates on the CEO seat above the DB.

create table if not exists public.kill_switches (
  -- the canonical node id from src/lib/control-tower/node-registry.ts. PK.
  node_id text primary key,
  -- the node's scope in the canonical org tree — mirrored from the registry at write time
  -- so a reader can classify without re-walking the tree. Constrained to the four levels
  -- the CEO cockpit exposes: department | director | agent | tool.
  scope text not null check (scope in ('department', 'director', 'agent', 'tool')),
  -- the workspace_members.display_name (or system actor) that flipped this node off — audit trail.
  off_by text not null,
  -- when the flip happened. Defaults to now() so the API route can omit it on upsert.
  off_at timestamptz not null default now(),
  -- optional free-text note from the CEO explaining why this node is off.
  reason text
);

alter table public.kill_switches enable row level security;
drop policy if exists kill_switches_select on public.kill_switches;
create policy kill_switches_select on public.kill_switches
  for select to authenticated using (auth.uid() is not null);
drop policy if exists kill_switches_service on public.kill_switches;
create policy kill_switches_service on public.kill_switches
  for all to service_role using (true) with check (true);

-- Seed EMPTY — an unconfigured registry never silently switches a node off.
-- Rows land only when the CEO explicitly toggles a node off from the cockpit.
