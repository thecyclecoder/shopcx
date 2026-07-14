-- list_spec_phase_anomalies — server-side spec_phases anomaly sweep, retire the residual
-- client-side `.in("id", specIds.slice(...))` batch loop in listSpecPhaseAnomalies.
--
-- Precedent: 20261001120000_list_specs_with_phases_rpc.sql. The specs+phases hot path already
-- runs server-side (list_specs_with_phases), but two secondary readers still marshal id/slug
-- arrays client-side to dodge the ~16KB undici header cap (UND_ERR_HEADERS_OVERFLOW). This RPC
-- handles anomaly #1 — the reconciler's spec-drift sweep (spec-drift.ts `detectSpecPhaseAnomalies`).
--
-- Shape: `returns table (kind text, phase_id uuid, spec_id uuid, "position" int, status text,
-- slug text, workspace_id uuid)` — every anomaly row tagged. Two kinds:
--   • 'orphan'         — spec_phases whose spec_id has no live specs row (parent gone). Global
--                        by nature (no parent to read a workspace from). slug + workspace_id are null.
--   • 'provenance_gap' — status='shipped', pr IS NULL AND merge_sha IS NULL, parent.workspace_id =
--                        p_workspace_id, parent.status <> 'folded'. slug + workspace_id resolved
--                        from the parent join.
--
-- Both computed in a SINGLE spec_phases LEFT JOIN specs — no id array crosses the wire. The join
-- reads the existing spec_phases → specs FK path (unindexed today, but the row count is bounded
-- by the phase table size); the workspace filter on the provenance-gap branch uses the existing
-- specs_ws_status_idx.

drop function if exists public.list_spec_phase_anomalies(uuid);

create or replace function public.list_spec_phase_anomalies(
  p_workspace_id uuid
)
returns table (
  kind text,
  phase_id uuid,
  spec_id uuid,
  "position" int,
  status text,
  slug text,
  workspace_id uuid
)
language sql
stable
as $$
  select
    case when s.id is null then 'orphan' else 'provenance_gap' end as kind,
    p.id       as phase_id,
    p.spec_id  as spec_id,
    p.position as "position",
    p.status   as status,
    s.slug     as slug,
    s.workspace_id as workspace_id
  from public.spec_phases p
  left join public.specs s on s.id = p.spec_id
  where
    -- ORPHAN (global — no parent to scope by workspace)
    s.id is null
    or (
      -- PROVENANCE GAP — shipped phase, no pr + no merge_sha, in the requested workspace,
      -- non-folded parent.
      p.status = 'shipped'
      and p.pr is null
      and p.merge_sha is null
      and s.workspace_id = p_workspace_id
      and s.status is distinct from 'folded'
    );
$$;

grant execute on function public.list_spec_phase_anomalies(uuid) to authenticated, service_role;
