-- get_spec_with_phases — server-side single-spec spec+phases join.
--
-- Phase 2 of docs/brain/specs/cut-internal-egress-pooler-and-spec-rpcs.md (the box-side sibling of
-- list_specs_with_phases from 20261001120000). The specs read path (src/lib/specs-table.ts:getSpec)
-- used to fire TWO PostgREST round-trips per call — one .from('specs') then one .from('spec_phases')
-- keyed on the returned id. On the box those two calls each pay the set_config preamble + auth
-- churn every time getSpec runs. This RPC collapses them into ONE call (fewer PostgREST calls +
-- fewer rows shipped) that the pooled box path can also invoke as a single pooled query.
--
-- Shape mirrors list_specs_with_phases (jsonb spec + jsonb phases) so getSpec can construct the
-- same SpecRow off the same to_jsonb() column set (no per-column mapping churn when a new column
-- lands on public.specs). `limit 1` is safe because `specs_ws_slug` (specs_and_spec_phases M1) is
-- unique on (workspace_id, slug).
--
-- Indexes: the (workspace_id, slug) unique index (specs_ws_slug) + spec_phases_spec_position
-- unique index cover the read; both are declared in 20260713120000_specs_and_spec_phases.sql
-- and 20261001120000_list_specs_with_phases_rpc.sql. Nothing new to add here.

-- Drop first: CREATE OR REPLACE FUNCTION cannot change the return signature, so redefinition with a
-- different output shape must drop before recreating (same pattern as list_specs_with_phases).
drop function if exists public.get_spec_with_phases(uuid, text);

create or replace function public.get_spec_with_phases(
  p_workspace_id uuid,
  p_slug text
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
    and s.slug = p_slug
  limit 1;
$$;

-- PostgREST needs an explicit grant to expose the RPC to authenticated / service_role callers.
-- The admin client (service_role) is the primary caller; keep authenticated in case a future
-- non-admin read path wants the same server-side join.
grant execute on function public.get_spec_with_phases(uuid, text) to authenticated, service_role;
