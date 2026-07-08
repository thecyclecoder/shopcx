-- Phase 1 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
--
-- Four RPCs that move analytics-tile aggregation into SQL so a >1000-row source
-- set is no longer silently truncated to the first 1000 rows PostgREST returns:
--
--   1. public.analytics_sol_cost           — Sol economics tile
--        (src/app/api/tickets/analytics/sol-cost/route.ts)
--   2. public.analytics_selective_clarify  — 7-day selective-clarify rate tile
--        (src/app/api/tickets/analytics/selective-clarify/route.ts)
--   3. public.ai_ticket_analytics          — AI agent analytics ticket buckets
--        (src/app/api/workspaces/[id]/analytics/ai/route.ts)
--   4. public.dunning_cycle_status_counts  — dunning cycle status GROUP BY
--        (src/app/api/workspaces/[id]/analytics/dunning/route.ts)
--
-- Mirrors the shape of public.estimate_sub_ltv
-- (supabase/migrations/20260708120000_estimate_sub_ltv_rpc.sql). Each function
-- is STABLE + SECURITY DEFINER, workspace-scoped by first argument, granted to
-- service_role + authenticated (RLS is not on the source tables that back the
-- admin-client callers, but SECURITY DEFINER matches the sibling analytics
-- RPCs' guarantee anyway).

-- ── 1. analytics_sol_cost ────────────────────────────────────────────────────
-- Powers /api/tickets/analytics/sol-cost. Replaces:
--   tickets.select('id, ai_cost_cents, csat_score')  no limit
--     → JS percentile + cohort split
-- with a single server-side aggregate that returns overall + pre_sol (no
-- ticket_directions row) + sol (has ≥1 ticket_directions row) cohorts, plus
-- the CSAT averages per cohort and the sol-cohort re-session histogram.
CREATE OR REPLACE FUNCTION public.analytics_sol_cost(
  p_workspace uuid,
  p_window_days int
)
RETURNS TABLE(
  overall_count bigint,
  overall_median_cents bigint,
  overall_p95_cents bigint,
  pre_sol_count bigint,
  pre_sol_median_cents bigint,
  pre_sol_p95_cents bigint,
  sol_count bigint,
  sol_median_cents bigint,
  sol_p95_cents bigint,
  pre_sol_csat_count bigint,
  pre_sol_csat_avg numeric,
  sol_csat_count bigint,
  sol_csat_avg numeric,
  resessions jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH window_tickets AS (
    SELECT t.id,
           coalesce(t.ai_cost_cents, 0)::bigint AS cents,
           t.csat_score
    FROM public.tickets t
    WHERE t.workspace_id = p_workspace
      AND t.created_at >= (now() - make_interval(days => p_window_days))
      AND t.merged_into IS NULL
  ),
  -- Per-ticket direction rollup: any row => sol cohort; supersede count is
  -- how many rows on the ticket carry superseded_at IS NOT NULL.
  dir_rollup AS (
    SELECT d.ticket_id,
           count(*) FILTER (WHERE d.superseded_at IS NOT NULL) AS supersede_count
    FROM public.ticket_directions d
    JOIN window_tickets w ON w.id = d.ticket_id
    WHERE d.workspace_id = p_workspace
    GROUP BY d.ticket_id
  ),
  cohorted AS (
    SELECT w.id,
           w.cents,
           w.csat_score,
           (dr.ticket_id IS NOT NULL) AS is_sol,
           coalesce(dr.supersede_count, 0)::int AS supersede_count
    FROM window_tickets w
    LEFT JOIN dir_rollup dr ON dr.ticket_id = w.id
  ),
  cost_agg AS (
    SELECT
      count(*)                                                       AS overall_count,
      coalesce(percentile_cont(0.5)  WITHIN GROUP (ORDER BY cents), 0)::bigint AS overall_median_cents,
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY cents), 0)::bigint AS overall_p95_cents,
      count(*) FILTER (WHERE NOT is_sol)                             AS pre_sol_count,
      coalesce(percentile_cont(0.5)  WITHIN GROUP (ORDER BY cents)
        FILTER (WHERE NOT is_sol), 0)::bigint                        AS pre_sol_median_cents,
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY cents)
        FILTER (WHERE NOT is_sol), 0)::bigint                        AS pre_sol_p95_cents,
      count(*) FILTER (WHERE is_sol)                                 AS sol_count,
      coalesce(percentile_cont(0.5)  WITHIN GROUP (ORDER BY cents)
        FILTER (WHERE is_sol), 0)::bigint                            AS sol_median_cents,
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY cents)
        FILTER (WHERE is_sol), 0)::bigint                            AS sol_p95_cents
    FROM cohorted
  ),
  csat_agg AS (
    SELECT
      count(*) FILTER (WHERE NOT is_sol AND csat_score IS NOT NULL) AS pre_sol_csat_count,
      avg(csat_score) FILTER (WHERE NOT is_sol AND csat_score IS NOT NULL) AS pre_sol_csat_avg,
      count(*) FILTER (WHERE is_sol AND csat_score IS NOT NULL)     AS sol_csat_count,
      avg(csat_score) FILTER (WHERE is_sol AND csat_score IS NOT NULL) AS sol_csat_avg
    FROM cohorted
  ),
  resessions_agg AS (
    SELECT coalesce(jsonb_agg(
             jsonb_build_object('supersede_count', supersede_count, 'tickets', tickets)
             ORDER BY supersede_count
           ), '[]'::jsonb) AS resessions
    FROM (
      SELECT supersede_count, count(*)::bigint AS tickets
      FROM cohorted
      WHERE is_sol
      GROUP BY supersede_count
    ) h
  )
  SELECT
    ca.overall_count, ca.overall_median_cents, ca.overall_p95_cents,
    ca.pre_sol_count, ca.pre_sol_median_cents, ca.pre_sol_p95_cents,
    ca.sol_count, ca.sol_median_cents, ca.sol_p95_cents,
    sa.pre_sol_csat_count, sa.pre_sol_csat_avg,
    sa.sol_csat_count, sa.sol_csat_avg,
    ra.resessions
  FROM cost_agg ca CROSS JOIN csat_agg sa CROSS JOIN resessions_agg ra;
$$;

COMMENT ON FUNCTION public.analytics_sol_cost(uuid, int) IS
  'Aggregate for /api/tickets/analytics/sol-cost — replaces an unbounded tickets.select(id, ai_cost_cents, csat_score) that truncated at 1000 rows. Returns overall + pre-Sol + Sol percentile/CSAT buckets and the Sol re-session histogram.';

GRANT EXECUTE ON FUNCTION public.analytics_sol_cost(uuid, int)
  TO service_role, authenticated;


-- ── 2. analytics_selective_clarify ───────────────────────────────────────────
-- Powers /api/tickets/analytics/selective-clarify. Replaces a
-- ticket_resolution_events.select('verified_outcome') scan (no limit → capped
-- at 1000) with a GROUP BY verified_outcome server-side.
CREATE OR REPLACE FUNCTION public.analytics_selective_clarify(
  p_workspace uuid,
  p_days int
)
RETURNS TABLE(
  total bigint,
  confirmed bigint,
  unbacked bigint,
  drifted bigint,
  clarified bigint,
  unknown_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*)::bigint                                                                 AS total,
    count(*) FILTER (WHERE verified_outcome = 'confirmed')::bigint                   AS confirmed,
    count(*) FILTER (WHERE verified_outcome = 'unbacked')::bigint                    AS unbacked,
    count(*) FILTER (WHERE verified_outcome = 'drifted')::bigint                     AS drifted,
    count(*) FILTER (WHERE verified_outcome = 'clarified')::bigint                   AS clarified,
    count(*) FILTER (WHERE verified_outcome IS NULL)::bigint                         AS unknown_count
  FROM public.ticket_resolution_events
  WHERE workspace_id = p_workspace
    AND staged_at >= (now() - make_interval(days => p_days));
$$;

COMMENT ON FUNCTION public.analytics_selective_clarify(uuid, int) IS
  'Aggregate for /api/tickets/analytics/selective-clarify — GROUP BY verified_outcome over a rolling window. Replaces an unbounded ticket_resolution_events.select() that truncated at 1000 rows.';

GRANT EXECUTE ON FUNCTION public.analytics_selective_clarify(uuid, int)
  TO service_role, authenticated;


-- ── 3. ai_ticket_analytics ───────────────────────────────────────────────────
-- Powers the tickets sub-buckets in /api/workspaces/[id]/analytics/ai.
-- Replaces an unbounded tickets.contains(tags,['ai']) scan (rows capped at
-- 1000 — every tag / channel / escalation sub-bucket wrong on a busy
-- workspace) with server-side aggregate counts + a per-tag jsonb bucket
-- unnested from the tickets.tags text[]. The ticket_ids array powers the
-- downstream ticket_messages regex pass in the caller (which chunks its own
-- read).
CREATE OR REPLACE FUNCTION public.ai_ticket_analytics(
  p_workspace uuid,
  p_since timestamptz
)
RETURNS TABLE(
  ai_ticket_count bigint,
  escalated bigint,
  chat_count bigint,
  email_count bigint,
  tag_buckets jsonb,
  ticket_ids uuid[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ai_tix AS (
    SELECT t.id, t.channel, t.tags, t.escalated_at
    FROM public.tickets t
    WHERE t.workspace_id = p_workspace
      AND t.created_at >= p_since
      AND t.tags @> ARRAY['ai']::text[]
  ),
  tag_agg AS (
    SELECT coalesce(jsonb_object_agg(tag, cnt), '{}'::jsonb) AS tag_buckets
    FROM (
      SELECT tag, count(*)::bigint AS cnt
      FROM (
        SELECT unnest(tags) AS tag FROM ai_tix
      ) t
      GROUP BY tag
    ) g
  ),
  base_agg AS (
    SELECT
      count(*)::bigint                                                      AS ai_ticket_count,
      count(*) FILTER (WHERE escalated_at IS NOT NULL)::bigint              AS escalated,
      count(*) FILTER (WHERE channel = 'chat')::bigint                      AS chat_count,
      count(*) FILTER (WHERE channel = 'email')::bigint                     AS email_count,
      coalesce(array_agg(id), ARRAY[]::uuid[])                              AS ticket_ids
    FROM ai_tix
  )
  SELECT
    b.ai_ticket_count, b.escalated, b.chat_count, b.email_count,
    tg.tag_buckets, b.ticket_ids
  FROM base_agg b CROSS JOIN tag_agg tg;
$$;

COMMENT ON FUNCTION public.ai_ticket_analytics(uuid, timestamptz) IS
  'Aggregate for the tickets sub-buckets in /api/workspaces/:id/analytics/ai — replaces an unbounded tickets.contains(tags,ai) select that truncated tag/channel/escalation sub-counts at 1000 rows.';

GRANT EXECUTE ON FUNCTION public.ai_ticket_analytics(uuid, timestamptz)
  TO service_role, authenticated;


-- ── 4. dunning_cycle_status_counts ───────────────────────────────────────────
-- Powers the cycleStats block in /api/workspaces/[id]/analytics/dunning.
-- Replaces a dunning_cycles.select('status, terminal_error_code') scan (rows
-- capped at 1000 — every status count and the recovery-rate wrong on any
-- workspace with >1000 cycles) with a single GROUP BY status + a bounded
-- terminal-cancel count.
CREATE OR REPLACE FUNCTION public.dunning_cycle_status_counts(
  p_workspace uuid
)
RETURNS TABLE(
  total bigint,
  active bigint,
  retrying bigint,
  skipped bigint,
  recovered bigint,
  exhausted bigint,
  terminal bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*)::bigint                                                              AS total,
    count(*) FILTER (WHERE status IN ('active', 'rotating'))::bigint              AS active,
    count(*) FILTER (WHERE status = 'retrying')::bigint                           AS retrying,
    count(*) FILTER (WHERE status = 'skipped')::bigint                            AS skipped,
    count(*) FILTER (WHERE status = 'recovered')::bigint                          AS recovered,
    count(*) FILTER (WHERE status = 'exhausted')::bigint                          AS exhausted,
    count(*) FILTER (WHERE status = 'exhausted' AND terminal_error_code IS NOT NULL)::bigint AS terminal
  FROM public.dunning_cycles
  WHERE workspace_id = p_workspace;
$$;

COMMENT ON FUNCTION public.dunning_cycle_status_counts(uuid) IS
  'Aggregate for /api/workspaces/:id/analytics/dunning cycleStats — replaces a fetch-all dunning_cycles select + six JS .filter().length that truncated at 1000 rows.';

GRANT EXECUTE ON FUNCTION public.dunning_cycle_status_counts(uuid)
  TO service_role, authenticated;
