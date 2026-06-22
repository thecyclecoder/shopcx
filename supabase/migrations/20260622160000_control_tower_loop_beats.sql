-- Control Tower monitor accuracy (control-tower-monitor-accuracy spec, Phase 1).
--
-- The snapshot's old global read — "latest 600 beats, order by ran_at desc" — had two
-- failure modes as the fleet grew to ~60 cron/agent-kind loops:
--   1) a low-frequency cron (daily today-sync, bursty meta-capi-dispatch) got its latest
--      beat crowded OUT of the 600-row window by high-frequency loops, so the monitor saw
--      0 beats and false-flagged it red `never_fired` after every deploy — even with 99 /
--      494 historical beats.
--   2) the global `order by ran_at desc` had no single-column index to ride, so on a
--      growing table it degraded to a full sort and started 500-ing
--      (GET /rest/v1/loop_heartbeats) — the Control Tower became a source of its own errors.
--
-- This function replaces that read with ONE index-friendly grouped query: the latest
-- `p_history_limit` beats PER loop_id plus the all-time beat count, for cron + agent-kind
-- loops only (inline-agent/reactive beats are high-volume and read separately via the
-- dedicated windowed fetch). It rides the existing (loop_id, ran_at desc) index, and
-- excluding the high-volume kinds bounds the scan. A loop with zero beats returns NO rows,
-- so the monitor reads "loop absent from this result ⇒ 0 beats ever ⇒ never_fired candidate"
-- and "present ⇒ has been invoked ⇒ at most a freshness alert, never never_fired".

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
  select loop_id, ran_at, ok, produced, detail, duration_ms, rn, total_count
  from (
    select
      h.loop_id, h.ran_at, h.ok, h.produced, h.detail, h.duration_ms,
      row_number() over (partition by h.loop_id order by h.ran_at desc) as rn,
      count(*) over (partition by h.loop_id) as total_count
    from public.loop_heartbeats h
    where h.kind not in ('inline-agent', 'reactive')
  ) ranked
  where rn <= greatest(p_history_limit, 1)
  order by loop_id, rn;
$$;

grant execute on function public.control_tower_loop_beats(int) to service_role;
grant execute on function public.control_tower_loop_beats(int) to authenticated;
