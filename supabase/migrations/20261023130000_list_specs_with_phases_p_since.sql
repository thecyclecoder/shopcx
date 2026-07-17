-- list_specs_with_phases — add a since-cursor for incremental polling.
--
-- Phase 5 of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md.
--
-- Every full-board poller (spec-test-cron, brain-roadmap readSpecsFromDb, spec-drift, roadmap
-- render) calls list_specs_with_phases with NO cursor today, so each tick re-ships the entire
-- (growing) boardable set of specs even when nothing changed. As directors autonomously generate
-- specs and the workspace table climbs from hundreds toward thousands, that whole-board scan is a
-- super-linear cost every incremental caller pays for data they don't need.
--
-- `public.specs.updated_at` is already maintained on every transition, so a `since` cursor lets an
-- incremental poller pull ONLY the rows that changed since its last high-water mark. Callers who
-- genuinely need the full board pass NULL (or omit the argument) — the pre-Phase-5 semantics
-- (every boardable spec in scope) are preserved by design.
--
-- Signature change: adding one optional parameter (`p_since timestamptz default null`) after the
-- existing `p_scope`. CREATE OR REPLACE FUNCTION cannot change the argument list, so drop the old
-- function first (same pattern as the 20261001120000 introduction + 20261004120000 get_spec_with_phases).
-- Callers that pass positional args by name (`p_workspace_id: ..., p_scope: ...`) or that omit
-- `p_since` keep working unchanged — the new parameter defaults to NULL.
--
-- Predicate: `AND (p_since IS NULL OR s.updated_at > p_since)` — null preserves the full-board
-- scan; a non-null cursor filters to rows updated strictly after the cursor (excludes the row that
-- WAS the cursor to avoid re-shipping the last-seen row). Index-friendly against a
-- (workspace_id, updated_at) index; the existing (workspace_id, status) index already gates the
-- workspace scope, so the additional filter costs only a per-row comparison.
--
-- Idempotent index: add (workspace_id, updated_at) so the change-probe (`SELECT max(updated_at)
-- FROM specs WHERE workspace_id = $1`) rides an index-only scan, and the delta filter above
-- benefits when a workspace holds many rows. `spec_read_eff_cursor` — mnemonic name.

create index if not exists specs_ws_updated_at_idx
  on public.specs (workspace_id, updated_at);

-- Drop first: CREATE OR REPLACE FUNCTION cannot change the parameter list.
drop function if exists public.list_specs_with_phases(uuid, text);

create or replace function public.list_specs_with_phases(
  p_workspace_id uuid,
  p_scope text default 'active',
  p_since timestamptz default null
)
returns table (spec jsonb, phases jsonb)
language sql
stable
as $$
  select
    to_jsonb(s) as spec,
    coalesce(
      (
        select jsonb_agg(to_jsonb(p) order by p.position)
        from public.spec_phases p
        where p.spec_id = s.id
      ),
      '[]'::jsonb
    ) as phases
  from public.specs s
  where s.workspace_id = p_workspace_id
    and (
      case p_scope
        when 'active'   then (s.status is null or s.status <> 'folded')
        when 'archived' then (s.status = 'folded')
        when 'all'      then true
        else (s.status is null or s.status <> 'folded') -- unknown scope → treat as 'active' (safe default)
      end
    )
    -- p_since — Phase 5 incremental cursor. NULL preserves pre-Phase-5 full-board semantics;
    -- a non-null value returns only rows whose updated_at is STRICTLY AFTER the cursor (excludes
    -- the last-seen row so an incremental poller doesn't re-ship its own high-water mark).
    and (p_since is null or s.updated_at > p_since);
$$;

-- PostgREST needs an explicit grant to expose the RPC to authenticated / service_role callers.
grant execute on function public.list_specs_with_phases(uuid, text, timestamptz) to authenticated, service_role;
