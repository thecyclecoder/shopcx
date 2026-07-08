-- roadmap_latest_needs_fix_reasons — server-side per-slug rollup, retire the residual
-- `inSpecSlugChunks` .in("spec_slug", …) batching in `readNeedsFixReasons` (src/lib/brain-roadmap.ts).
--
-- Precedent: 20261002120000_roadmap_rollups_rpc.sql. Two of the three brain-roadmap per-slug
-- readers (`readInTestingSignals` → roadmap_latest_build_signals, `recordInTestingTransitions` →
-- roadmap_latest_status_transitions) already moved server-side; this closes out the third — the
-- vale-instant-per-spec-review needs-fix reason overlay (readNeedsFixReasons). Additive
-- CREATE FUNCTION only — no schema/data change, so it clears the additive-migration leash.
--
-- Shape: `returns table (spec_slug text, reason text, metadata jsonb)`. LATEST row per spec_slug
-- via `distinct on (spec_slug) ... order by spec_slug, created_at desc`, filtered to
-- `action_kind = 'spec_review_needs_fix'` and the requested workspace. Exactly one row per slug,
-- bounded server-side — no slug array crosses the wire, no in-memory newest-first reduce.
--
-- Index: the existing director_activity_spec_idx (spec_slug) is only a slug-lookup helper. A
-- (workspace_id, spec_slug, created_at desc) index makes the `distinct on` scan an index range
-- per spec_slug (matching the shape of agent_jobs_slug_idx + spec_status_history_slug_at above).
-- Declared idempotently so a fresh DB gets it and this migration is self-contained.

create index if not exists director_activity_ws_slug_created_idx
  on public.director_activity (workspace_id, spec_slug, created_at desc);

drop function if exists public.roadmap_latest_needs_fix_reasons(uuid);

create or replace function public.roadmap_latest_needs_fix_reasons(p_workspace_id uuid)
returns table (spec_slug text, reason text, metadata jsonb)
language sql
stable
as $$
  select distinct on (d.spec_slug)
    d.spec_slug, d.reason, d.metadata
  from public.director_activity d
  where d.workspace_id = p_workspace_id
    and d.action_kind = 'spec_review_needs_fix'
    and d.spec_slug is not null
    and d.spec_slug <> ''
  order by d.spec_slug, d.created_at desc;
$$;

grant execute on function public.roadmap_latest_needs_fix_reasons(uuid) to authenticated, service_role;
