-- Control Tower loop-beats RPC — stop the 500 (control-tower-loop-beats-rpc-perf spec, Phase 1).
--
-- The first cut of this function (20260622160000) replaced the global window read with a
-- per-loop window — but it still scanned + sorted the WHOLE cron+agent beat history on every
-- call: row_number() OVER (partition by loop_id order by ran_at desc) AND count(*) OVER
-- (partition by loop_id) over every row with no bound, then filtered rn <= limit. That is a
-- full scan + partition/sort of the entire (ever-growing) table per snapshot call — the exact
-- full-sort degradation it was built to replace. The Supabase feed showed it 500-ing
-- (POST /rest/v1/rpc/control_tower_loop_beats ×15, statement timeout).
--
-- This rewrite bounds the work two ways:
--   1) LATERAL JOIN instead of a global window. We take the distinct set of loop_ids, then for
--      each one a correlated subquery reads only its latest p_history_limit beats — riding the
--      (loop_id, ran_at desc) index, ≤N index rows per loop, no global sort.
--   2) DROP count(*) OVER (the costly part). The monitor only needs "has this loop EVER beaten?"
--      (the never_fired signal), which is simply PRESENCE: a loop with zero beats isn't in the
--      distinct set → absent from the result → 0-beats-ever → never_fired candidate; present ⇒
--      has beaten ⇒ at most a freshness alert. No all-time count needed. (If a count is ever
--      wanted, take it from a separate cheap `group by` — never a per-row window.)
--
-- No time floor on the lateral: it already reads ≤N index rows per loop regardless of table
-- size, so a floor buys nothing — and a floor inside the lateral would DROP a loop whose only
-- beats are older than the floor from the result entirely, falsely making it look never_fired.
-- Presence (ever-beaten) stays correct because the distinct-loop_id set is computed table-wide.
--
-- The one table-wide step — `select distinct loop_id where kind not in (...)` — gets its own
-- PARTIAL index so it never seq-scans the whole (inline-agent/reactive-dominated) feed: the index
-- covers only the cron+agent-kind rows, so the planner satisfies the distinct with an index-only
-- scan over a small index instead of a full heap scan. Without it, this distinct is the last
-- unbounded scan and would re-introduce the statement-timeout 500 under PostgREST's tighter limit.
create index if not exists loop_heartbeats_active_kind_loop_idx
  on public.loop_heartbeats (loop_id)
  where kind not in ('inline-agent', 'reactive');

-- DROP before CREATE: this rewrite removes the `total_count` output column (the dropped
-- count(*) OVER), and CREATE OR REPLACE FUNCTION cannot change a function's return type /
-- remove an OUT parameter ("cannot change return type of existing function"). Drop the old
-- definition first; the (int) argument signature is unchanged so this targets it exactly.
drop function if exists public.control_tower_loop_beats(int);

create or replace function public.control_tower_loop_beats(p_history_limit int default 10)
returns table (
  loop_id text,
  ran_at timestamptz,
  ok boolean,
  produced jsonb,
  detail text,
  duration_ms int,
  rn bigint
)
language sql
stable
as $$
  select b.loop_id, b.ran_at, b.ok, b.produced, b.detail, b.duration_ms, b.rn
  from (
    select distinct h.loop_id
    from public.loop_heartbeats h
    where h.kind not in ('inline-agent', 'reactive')
  ) l
  cross join lateral (
    select
      hb.loop_id, hb.ran_at, hb.ok, hb.produced, hb.detail, hb.duration_ms,
      row_number() over (order by hb.ran_at desc) as rn
    from public.loop_heartbeats hb
    where hb.loop_id = l.loop_id
      and hb.kind not in ('inline-agent', 'reactive')
    order by hb.ran_at desc
    limit greatest(p_history_limit, 1)
  ) b
  order by b.loop_id, b.rn;
$$;

grant execute on function public.control_tower_loop_beats(int) to service_role;
grant execute on function public.control_tower_loop_beats(int) to authenticated;
