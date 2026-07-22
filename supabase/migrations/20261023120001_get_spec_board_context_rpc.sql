-- get_spec_board_context — server-side collapse of the cold brain-roadmap.getSpec fan-out.
--
-- Phase 1 of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md — spec-read-eff-board-context.
--
-- Cold brain-roadmap.getSpec (src/lib/brain-roadmap.ts:1500) currently assembles its result from
-- FOUR reads that all key on the same workspace + slug:
--   (1) get_spec_with_phases(ws, slug)                 — pooled, one round-trip
--   (2) listSpecs(ws)      via list_specs_with_phases  — PostgREST, still pays the set_config preamble
--   (3) getSpecCardStates(ws)                          — PostgREST full-workspace scan
--   (4) listGoals(ws)      goals + goal_milestones     — TWO PostgREST round-trips
-- That's 4-6 network round-trips per cold read, and the 15s in-process cache
-- (SPEC_CACHE_TTL_MS, specs-table.ts:407) is per-subprocess — every fresh `claude -p` re-pays them.
-- As directors autonomously generate specs (growing the tables the whole-workspace scans traverse)
-- and more agents run concurrently, this degrades super-linearly.
--
-- This RPC returns EVERYTHING getSpec needs to build its SpecCard in ONE pooled round-trip:
--   • spec              — the target `public.specs` row (jsonb) — NULL when the slug does not exist.
--   • phases            — jsonb array of the target's `spec_phases`, ordered by position.
--   • boardable_specs   — jsonb array of every boardable spec (status IS NULL OR status <> 'folded')
--                         in the workspace with its phases — the exact set `resolveBlockedBy` needs
--                         to fill title/status/cleared on each `blocked_by` entry, mirrored on the
--                         SAME (spec jsonb, phases jsonb) row shape `list_specs_with_phases` returns
--                         so the caller can reuse `specRowFromDb` without a per-column map.
--   • card_state        — the target slug's `public.spec_card_state` row (jsonb) — NULL when the
--                         card-state overlay hasn't been written for this slug (its transient
--                         short_circuit / merged_pr flags aren't on `public.specs` yet).
--   • goal_memberships  — jsonb array of one row per goal-MEMBER spec in the workspace with the
--                         owning goal's slug/title/main_merge_sha — the exact projection
--                         `buildGoalMembershipMap` builds (spec slug → GoalMembership) so the
--                         outside-dependent goal blocker normalization can run without a separate
--                         listGoals fan-out. Standalone (no-milestone) specs are absent by design.
--
-- ALWAYS returns exactly one row so the caller can rely on the shape — `spec IS NULL` is the
-- "no such slug" signal. Fail-open pool contract: the caller (getSpec) falls back to the
-- pre-RPC four-call path on any pool miss / query error.
--
-- Indexes: the joins ride the existing `specs_ws_slug` (workspace_id, slug), `specs_ws_status_idx`
-- (workspace_id, status), `spec_phases_spec_position` (spec_id, position), and `spec_card_state_ws_slug`
-- (workspace_id, spec_slug) — all declared in the initial `specs_and_spec_phases`,
-- `list_specs_with_phases_rpc`, and `spec_card_state` migrations. The goal-membership walk uses the
-- `goal_milestones.id` primary key + the `goals.id` primary key. Nothing new to add.

-- Drop first: CREATE OR REPLACE FUNCTION cannot change the return signature, so any future re-shape
-- must drop before recreating (same pattern as list_specs_with_phases / get_spec_with_phases).
drop function if exists public.get_spec_board_context(uuid, text);

create or replace function public.get_spec_board_context(
  p_workspace_id uuid,
  p_slug text
)
returns table (
  spec jsonb,
  phases jsonb,
  boardable_specs jsonb,
  card_state jsonb,
  goal_memberships jsonb
)
language sql
stable
as $$
  select
    (
      select to_jsonb(s)
      from public.specs s
      where s.workspace_id = p_workspace_id
        and s.slug = p_slug
      limit 1
    ) as spec,
    coalesce(
      (
        select jsonb_agg(to_jsonb(p) order by p.position)
        from public.spec_phases p
        where p.spec_id = (
          select id from public.specs
          where workspace_id = p_workspace_id and slug = p_slug
          limit 1
        )
      ),
      '[]'::jsonb
    ) as phases,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'spec', to_jsonb(s),
            'phases', coalesce(
              (
                select jsonb_agg(to_jsonb(p2) order by p2.position)
                from public.spec_phases p2
                where p2.spec_id = s.id
              ),
              '[]'::jsonb
            )
          )
        )
        from public.specs s
        where s.workspace_id = p_workspace_id
          and (s.status is null or s.status <> 'folded')
      ),
      '[]'::jsonb
    ) as boardable_specs,
    (
      select to_jsonb(scs)
      from public.spec_card_state scs
      where scs.workspace_id = p_workspace_id
        and scs.spec_slug = p_slug
      limit 1
    ) as card_state,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'spec_slug', s.slug,
            'goal_slug', g.slug,
            'goal_title', g.title,
            'main_merge_sha', g.main_merge_sha
          )
        )
        from public.specs s
        join public.goal_milestones m on m.id = s.milestone_id
        join public.goals g on g.id = m.goal_id
        where s.workspace_id = p_workspace_id
          and s.milestone_id is not null
      ),
      '[]'::jsonb
    ) as goal_memberships;
$$;

-- PostgREST needs an explicit grant to expose the RPC to authenticated / service_role callers.
-- The admin client (service_role) is the primary caller; keep authenticated in case a future
-- non-admin read path wants the same server-side collapse.
grant execute on function public.get_spec_board_context(uuid, text) to authenticated, service_role;
