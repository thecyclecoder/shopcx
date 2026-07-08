-- control_tower_snapshot — server-side consolidation of the Control Tower's per-workspace panel
-- reads into ONE round trip.
--
-- Phase 3 of docs/brain/specs/cut-internal-egress-pooler-and-spec-rpcs.md. The
-- /api/developer/control-tower route used to fire ~10-15 DB SELECTs per ~15s tick per viewing
-- client (top-tables + two loop_heartbeats beats + open db_health / repair / director-dismissed /
-- coverage-register / spec_drift / claude_health rows), each carrying a set_config preamble. This
-- RPC returns every panel's raw rows as a single `jsonb` payload so the API route can consume it
-- with ONE call. The heavier `buildControlTowerSnapshot` + `buildErrorFeedSnapshot` helpers stay
-- (they iterate per-loop / per-source and need their own derivation) — this covers the raw-SELECT
-- panels only.
--
-- Shape (jsonb):
--   {
--     top_tables: [{ table_name, total_bytes, row_estimate }, …],   -- latest captured_at, top 15 by size
--     slowq_beat: { ran_at, produced } | null,                       -- latest db-health-slow-query beat
--     size_beat:  { ran_at, produced } | null,                       -- latest db-health-size-sweep beat
--     db_health_proposals:   [{ id, spec_slug, status, instructions, pending_actions, log_tail, created_at }, …],
--     repairs:               [{ id, spec_slug, status, instructions, pending_actions, log_tail, created_at }, …],
--     director_dismissed:    [{ action_kind, reason, metadata, created_at }, …],   -- last 14 days, both kinds
--     coverage_register:     [{ id, spec_slug, status, instructions, created_at }, …],
--     spec_drift:            [{ id, spec_slug, phase_index, phase_title, current_emoji, detail, status, opened_at, last_seen_at }, …],
--     claude_health:         { api_status, code_status, external_down, last_polled_at, poll_ok, consecutive_failures,
--                              last_failure_at, breaker_open, tripped_at, recovered_at, detail, updated_at } | null
--   }
--
-- Each sub-array mirrors the exact select list the TS helper (`getDbHealthPanel` / `getOpenRepairs`
-- / `getDirectorDismissedRepairs` / `getOpenCoverageRegistrations` / `getOpenSpecDrift` /
-- `getClaudeHealth`) already reads, so a new consumer (`getControlTowerDbPanels` in
-- src/lib/control-tower/snapshot.ts) can shape it into the same panel types without a new schema
-- contract. The 14-day director-dismissed window matches DIRECTOR_DISMISS_WINDOW_MS in repair-agent.
--
-- Indexes: every read below is served by an existing index (specs_ws_status_idx / agent_jobs
-- workspace_kind_status / loop_heartbeats loop_ran / db_table_size_history captured_at DESC / etc.),
-- so no new index is added here — see the individual table migrations for the covering indexes.

drop function if exists public.control_tower_snapshot(uuid);

create or replace function public.control_tower_snapshot(
  p_workspace_id uuid
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'top_tables', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'table_name',   t.table_name,
                 'total_bytes',  t.total_bytes,
                 'row_estimate', t.row_estimate
               )
               order by t.total_bytes desc
             )
        from (
          select h.table_name, h.total_bytes, h.row_estimate
            from public.db_table_size_history h
           where h.captured_at = (
             select captured_at from public.db_table_size_history
              order by captured_at desc
              limit 1
           )
           order by h.total_bytes desc
           limit 15
        ) t
    ), '[]'::jsonb),

    'slowq_beat', (
      select jsonb_build_object('ran_at', b.ran_at, 'produced', b.produced)
        from public.loop_heartbeats b
       where b.loop_id = 'db-health-slow-query'
       order by b.ran_at desc
       limit 1
    ),

    'size_beat', (
      select jsonb_build_object('ran_at', b.ran_at, 'produced', b.produced)
        from public.loop_heartbeats b
       where b.loop_id = 'db-health-size-sweep'
       order by b.ran_at desc
       limit 1
    ),

    'db_health_proposals', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id',              j.id,
                 'spec_slug',       j.spec_slug,
                 'status',          j.status,
                 'instructions',    j.instructions,
                 'pending_actions', j.pending_actions,
                 'log_tail',        j.log_tail,
                 'created_at',      j.created_at
               )
               order by j.created_at desc
             )
        from (
          select id, spec_slug, status, instructions, pending_actions, log_tail, created_at
            from public.agent_jobs
           where workspace_id = p_workspace_id
             and kind = 'db_health'
             and status in ('needs_approval', 'needs_attention')
           order by created_at desc
           limit 50
        ) j
    ), '[]'::jsonb),

    'repairs', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id',              j.id,
                 'spec_slug',       j.spec_slug,
                 'status',          j.status,
                 'instructions',    j.instructions,
                 'pending_actions', j.pending_actions,
                 'log_tail',        j.log_tail,
                 'created_at',      j.created_at
               )
               order by j.created_at desc
             )
        from (
          select id, spec_slug, status, instructions, pending_actions, log_tail, created_at
            from public.agent_jobs
           where workspace_id = p_workspace_id
             and kind = 'repair'
             and status in ('needs_approval', 'needs_attention')
           order by created_at desc
           limit 50
        ) j
    ), '[]'::jsonb),

    'director_dismissed', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'action_kind', a.action_kind,
                 'reason',      a.reason,
                 'metadata',    a.metadata,
                 'created_at',  a.created_at
               )
               order by a.created_at desc
             )
        from (
          select action_kind, reason, metadata, created_at
            from public.director_activity
           where workspace_id = p_workspace_id
             and director_function = 'platform'
             and action_kind in ('dismissed_repair', 'reopened_repair')
             and created_at >= now() - interval '14 days'
           order by created_at desc
           limit 200
        ) a
    ), '[]'::jsonb),

    'coverage_register', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id',           j.id,
                 'spec_slug',    j.spec_slug,
                 'status',       j.status,
                 'instructions', j.instructions,
                 'created_at',   j.created_at
               )
               order by j.created_at desc
             )
        from (
          select id, spec_slug, status, instructions, created_at
            from public.agent_jobs
           where workspace_id = p_workspace_id
             and kind = 'coverage-register'
             and status = 'needs_approval'
           order by created_at desc
           limit 50
        ) j
    ), '[]'::jsonb),

    'spec_drift', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id',            d.id,
                 'spec_slug',     d.spec_slug,
                 'phase_index',   d.phase_index,
                 'phase_title',   d.phase_title,
                 'current_emoji', d.current_emoji,
                 'detail',        d.detail,
                 'status',        d.status,
                 'opened_at',     d.opened_at,
                 'last_seen_at',  d.last_seen_at
               )
               order by d.last_seen_at desc
             )
        from (
          select id, spec_slug, phase_index, phase_title, current_emoji, detail, status, opened_at, last_seen_at
            from public.spec_drift
           where workspace_id = p_workspace_id
             and status = 'open'
           order by last_seen_at desc
           limit 100
        ) d
    ), '[]'::jsonb),

    'claude_health', (
      select jsonb_build_object(
               'api_status',           c.api_status,
               'code_status',          c.code_status,
               'external_down',        c.external_down,
               'last_polled_at',       c.last_polled_at,
               'poll_ok',              c.poll_ok,
               'consecutive_failures', c.consecutive_failures,
               'last_failure_at',      c.last_failure_at,
               'breaker_open',         c.breaker_open,
               'tripped_at',           c.tripped_at,
               'recovered_at',         c.recovered_at,
               'detail',               c.detail,
               'updated_at',           c.updated_at
             )
        from public.claude_health c
       where c.id = 'singleton'
       limit 1
    )
  );
$$;

-- PostgREST needs an explicit grant. The admin client (service_role) is the primary caller (the
-- Control Tower API route runs owner-gated); keep authenticated in case an owner-scoped RLS-safe
-- read path wants it later.
grant execute on function public.control_tower_snapshot(uuid) to authenticated, service_role;
