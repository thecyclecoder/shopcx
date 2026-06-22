-- Control Tower: control_tower_loop_beats must not full-scan loop_heartbeats
-- (control-tower-loop-beats-rpc-timeout spec, Phase 1).
--
-- The previous body computed `row_number() over (partition by loop_id order by ran_at desc)`
-- AND `count(*) over (partition by loop_id)` across the ENTIRE loop_heartbeats table
-- (kind not in inline-agent/reactive) BEFORE filtering rn <= p_history_limit. The window
-- aggregation cannot ride the (loop_id, ran_at desc) index — Postgres must materialize and
-- sort every qualifying row first — so on the live 5.22M-row table it degraded to a full
-- scan + sort measured at 8101ms, hit the statement timeout, and returned null. The snapshot
-- (buildControlTowerSnapshot) then saw zero beats and false-flagged healthy crons
-- (`loop:portal-action-healer`, meta-capi-dispatch-cron, slack-roadmap-notify, ticket-unsnooze)
-- as never_fired.
--
-- This rewrite keeps the SAME output contract (one row per beat, latest p_history_limit per
-- loop, ordered loop_id then newest-first, with rn + a presence-count) but makes every read
-- index-backed against the existing (loop_id, ran_at desc) index:
--
--   1) `distinct_loops` — a recursive index skip-scan that walks the (loop_id, …) index in
--      ~one seek per distinct loop_id (≈60 loops) instead of an index-only scan over all
--      5.2M tuples. Each step jumps to the next loop_id > the previous one.
--   2) For each loop, a LATERAL fetches only its newest p_history_limit beats — an index
--      range seek on (loop_id, ran_at desc) that stops after the limit, never scanning the
--      loop's full history.
--   3) rn and total_count are now windows over that already-bounded per-loop set (≤ p_history_limit
--      rows), not over the whole table. total_count is therefore a PRESENCE signal (1..limit),
--      not the all-time count — which is all the monitor needs: every evalCron read tests it via
--      `everBeatCount === 0` (a loop absent from the result ⇒ 0 beats ever ⇒ never_fired candidate;
--      present ⇒ has been invoked ⇒ at most a freshness alert). See src/lib/control-tower/monitor.ts.
--
-- A loop with zero (non-inline/reactive) beats yields no LATERAL rows ⇒ absent from the result,
-- exactly as before. No new index or retention is required — the existing index covers both reads.

create or replace function public.control_tower_loop_beats(p_history_limit int default 10)
returns table (
  loop_id text,
  ran_at timestamptz,
  ok boolean,
  produced jsonb,
  detail text,
  duration_ms int,
  rn bigint,
  total_count bigint
)
language sql
stable
as $$
  with recursive distinct_loops(loop_id) as (
    -- Seed: the lowest loop_id (single index seek).
    (select h.loop_id
       from public.loop_heartbeats h
      order by h.loop_id
      limit 1)
    union all
    -- Skip-scan: jump straight to the next loop_id greater than the current one.
    select (select h.loop_id
              from public.loop_heartbeats h
             where h.loop_id > dl.loop_id
             order by h.loop_id
             limit 1)
      from distinct_loops dl
     where dl.loop_id is not null
  )
  select
    beats.loop_id,
    beats.ran_at,
    beats.ok,
    beats.produced,
    beats.detail,
    beats.duration_ms,
    beats.rn,
    beats.total_count
  from (
    select
      dl.loop_id,
      h.ran_at, h.ok, h.produced, h.detail, h.duration_ms,
      row_number() over (partition by dl.loop_id order by h.ran_at desc) as rn,
      count(*) over (partition by dl.loop_id) as total_count
    from distinct_loops dl
    cross join lateral (
      select h.ran_at, h.ok, h.produced, h.detail, h.duration_ms
      from public.loop_heartbeats h
      where h.loop_id = dl.loop_id
        and h.kind not in ('inline-agent', 'reactive')
      order by h.ran_at desc
      limit greatest(p_history_limit, 1)
    ) h
    where dl.loop_id is not null
  ) beats
  order by beats.loop_id, beats.rn;
$$;

grant execute on function public.control_tower_loop_beats(int) to service_role;
grant execute on function public.control_tower_loop_beats(int) to authenticated;
