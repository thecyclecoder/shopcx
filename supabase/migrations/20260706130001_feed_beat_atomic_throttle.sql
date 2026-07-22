-- Atomic per-minute throttle for feed:<source> liveness beats (feed-liveness-beat-atomic-throttle, Phase 1).
--
-- recordFeedDelivery() guarded feed beats with a per-warm-instance in-memory map PLUS a non-atomic
-- SELECT-then-INSERT recency check. Under the ~175/sec Vercel log-drain firehose across many
-- concurrent/cold serverless instances, every invocation SELECT-misses before any beat is visible
-- and then all INSERT — 15,508 feed:vercel beats in one hour (vs intended ≤60/hr), whose insert
-- storm momentarily saturated the DB and produced 99 POST /rest/v1/loop_heartbeats 500s
-- (Control Tower signature supabase-logs:6f16957ed72e1f38).
--
-- A feed beat is pure recency-of-latest liveness, so ONE row per minute per source is sufficient and
-- should be enforced authoritatively at the DB, not by a leaky best-effort read guard. We add a UNIQUE
-- partial index keyed on (loop_id, the truncated-to-minute ran_at) for kind='feed', and switch the
-- insert to ON CONFLICT DO NOTHING (via record_feed_beat). Now every racer past the first in a minute
-- no-ops atomically at the DB instead of all inserting.
--
-- IMMUTABILITY NOTE: date_trunc('minute', timestamptz) is only STABLE (it depends on the session
-- TimeZone), so it can't sit in an index expression. date_trunc('minute', ran_at AT TIME ZONE 'UTC')
-- is IMMUTABLE (AT TIME ZONE 'UTC' yields a timestamp-without-tz, and date_trunc over that is
-- immutable). The RPC's ON CONFLICT target below uses the IDENTICAL expression so the index is the
-- inferred arbiter.

-- 1) Dedup any existing same-minute feed beats so the UNIQUE index can be created. Keep the earliest
--    beat per (loop_id, minute); drop the rest. Bounded to kind='feed' rows (the only ones the index
--    covers). With 3-day retention this set is small; the one-time storm backlog is collapsed here.
delete from public.loop_heartbeats
where ctid in (
  select ctid from (
    select ctid,
           row_number() over (
             partition by loop_id, date_trunc('minute', ran_at at time zone 'UTC')
             order by ran_at, ctid
           ) as rn
    from public.loop_heartbeats
    where kind = 'feed'
  ) s
  where s.rn > 1
);

-- 2) The authoritative throttle: ≤1 feed beat per (source, minute) is now a DB invariant.
create unique index if not exists loop_heartbeats_feed_minute_uidx
  on public.loop_heartbeats (loop_id, (date_trunc('minute', ran_at at time zone 'UTC')))
  where kind = 'feed';

-- 3) Atomic insert helper: the burst-safe path recordFeedDelivery() calls instead of SELECT-then-INSERT.
--    ON CONFLICT DO NOTHING infers loop_heartbeats_feed_minute_uidx from the matching expression +
--    predicate, so concurrent racers in the same minute collapse to a single row with no error.
create or replace function public.record_feed_beat(p_loop_id text)
returns void
language sql
as $$
  insert into public.loop_heartbeats (loop_id, kind, ok, ran_at)
  values (p_loop_id, 'feed', true, now())
  on conflict (loop_id, (date_trunc('minute', ran_at at time zone 'UTC'))) where kind = 'feed'
  do nothing;
$$;

grant execute on function public.record_feed_beat(text) to service_role;
