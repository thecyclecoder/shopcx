-- roadmap_latest_build_signals + roadmap_latest_status_transitions — server-side per-slug rollups.
--
-- Phase 3 of docs/brain/specs/list-specs-with-phases-rpc-retire-in-array-client-join.md. The
-- roadmap/pipeline page's `readSpecsFromDb` → `readInTestingSignals` / `recordInTestingTransitions`
-- readers used to slug-batch a full-table scan of `agent_jobs` (kind='build', limit 2000) and
-- `spec_status_history` (field='status', limit 5000), then reduce in memory to newest-per-slug —
-- an N-query fan-out that grew with the workspace's spec count and was the cause of the slow
-- roadmap page load.
--
-- Both signals are LATEST-PER-SLUG rollups: `distinct on (spec_slug) ... order by spec_slug,
-- created_at desc` is exactly one row per slug (and one index range scan per slug) via the existing
-- (workspace_id, spec_slug, created_at desc) / (workspace_id, spec_slug, at desc) indexes —
-- BOUNDED server-side, no id array on the wire, no 2000/5000-row over-fetch, no in-memory reduce.
--
-- Scope: workspace-scoped. Only rows the readers actually consume are returned:
--   • build_signals — (spec_slug, status, preview_url) for kind='build' rows (the columns
--     `readInTestingSignals` reads: preview_url → hasPreview, status → hasLiveBuild + merged).
--   • status_transitions — (spec_slug, to_value) for field='status' rows (the ONLY columns
--     `recordInTestingTransitions` reads for its idempotency check).
--
-- Indexes: both rely on existing indexes shipped with the base tables:
--   • `agent_jobs_slug_idx  (workspace_id, spec_slug, created_at desc)` — 20260618120000
--   • `spec_status_history_slug_at (workspace_id, spec_slug, at desc)` — 20260624130000
-- Declared idempotently here so a fresh DB gets them and this migration is self-contained.

create index if not exists agent_jobs_slug_idx
  on public.agent_jobs (workspace_id, spec_slug, created_at desc);

create index if not exists spec_status_history_slug_at
  on public.spec_status_history (workspace_id, spec_slug, at desc);

-- ──────────────────────────────────────────────────────────────────────────────
-- roadmap_latest_build_signals — latest kind='build' agent_jobs row per spec_slug.
-- ──────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION cannot change the return signature; DROP first so a shape change
-- (adding/removing columns) applies cleanly.
drop function if exists public.roadmap_latest_build_signals(uuid);

create or replace function public.roadmap_latest_build_signals(p_workspace_id uuid)
returns table (spec_slug text, status text, preview_url text)
language sql
stable
as $$
  select distinct on (j.spec_slug)
    j.spec_slug, j.status, j.preview_url
  from public.agent_jobs j
  where j.workspace_id = p_workspace_id
    and j.kind = 'build'
    and j.spec_slug is not null
    and j.spec_slug <> ''
  order by j.spec_slug, j.created_at desc;
$$;

grant execute on function public.roadmap_latest_build_signals(uuid) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- roadmap_latest_status_transitions — latest field='status' spec_status_history row per spec_slug.
-- ──────────────────────────────────────────────────────────────────────────────
drop function if exists public.roadmap_latest_status_transitions(uuid);

create or replace function public.roadmap_latest_status_transitions(p_workspace_id uuid)
returns table (spec_slug text, to_value text)
language sql
stable
as $$
  select distinct on (h.spec_slug)
    h.spec_slug, h.to_value
  from public.spec_status_history h
  where h.workspace_id = p_workspace_id
    and h.field = 'status'
  order by h.spec_slug, h.at desc;
$$;

grant execute on function public.roadmap_latest_status_transitions(uuid) to authenticated, service_role;
