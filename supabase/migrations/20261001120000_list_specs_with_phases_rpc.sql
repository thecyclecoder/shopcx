-- list_specs_with_phases — server-side spec+phases join, retire the client-side .in([ids]) fan-out.
--
-- The spec read path (listSpecs in src/lib/specs-table.ts + readSpecsFromDb/getRoadmap in
-- src/lib/brain-roadmap.ts) used to fetch every spec, then ship a `.in("spec_id", [all ids])` array
-- back to PostgREST to load their phases. Once the workspace held a few hundred specs, the id array
-- URL overflowed the ~16KB undici header cap (UND_ERR_HEADERS_OVERFLOW) — wedging getSpec, the build
-- claim-gate and the spec-review enqueue reaper. PR #1429 + #1430 batched the .in() as an interim; the
-- durable fix is to do the join SERVER-SIDE so no id array ever crosses the wire.
--
-- Scope filter (server-side):
--   'active'   — every boardable spec: `status IS NULL OR status <> 'folded'`
--   'archived' — folded specs only: `status = 'folded'`
--   'all'      — no status filter
-- The board's callers filter folded out today via isBoardableStatus (src/lib/brain-roadmap.ts); the
-- same predicate lives here so the roadmap load never pulls archived rows across the wire.
--
-- Shape: `returns table (spec jsonb, phases jsonb)`.
--   • `spec` is `to_jsonb(s)` — every current + future column on public.specs, no migration churn when
--     a new column lands. The app maps back to SpecRowDb by key.
--   • `phases` is a jsonb array of spec_phases rows ORDERED BY position (empty array when the spec has
--     no phases). The correlated subquery reads at most that spec's phases via the existing
--     spec_phases_spec_position (spec_id, position) unique index — no all-phases table scan.
--
-- Indexes: the two indexes the join relies on already exist (specs_ws_status_idx on
-- (workspace_id, status) + spec_phases_spec_position on (spec_id, position) — from the initial
-- 20260713120000 migration). Declared here idempotently so a fresh DB gets them and this migration is
-- self-contained.

create index if not exists specs_ws_status_idx
  on public.specs (workspace_id, status);

create unique index if not exists spec_phases_spec_position
  on public.spec_phases (spec_id, position);

-- Drop first: CREATE OR REPLACE FUNCTION cannot change the return signature, so if this function is
-- ever redefined with a different output shape the migration must drop it before re-creating.
drop function if exists public.list_specs_with_phases(uuid, text);

create or replace function public.list_specs_with_phases(
  p_workspace_id uuid,
  p_scope text default 'active'
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
    );
$$;

-- PostgREST needs an explicit grant to expose the RPC to the authenticated / service_role clients.
-- The admin client (service_role) is the primary caller; keep authenticated in case a future
-- non-admin read path wants the same server-side join.
grant execute on function public.list_specs_with_phases(uuid, text) to authenticated, service_role;
