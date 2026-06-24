# Atomic per-minute throttle for feed:<source> liveness beats (kill the Vercel-drain write storm) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/control-tower/error-feed.ts (recordfeeddelivery) + a supabase/migrations/*.sql adding a unique partial index on loop_heartbeats(loop_id, date_trunc(minute, ran_at)) where kind=feed, with the insert switched to on conflict do nothing::real-bug`
**Repair-signature:** `supabase-logs:6f16957ed72e1f38`
**Repair-signature:** `cluster:repair`

Make the feed-delivery liveness beat throttle atomic so a Vercel log-drain burst can no longer storm loop_heartbeats and trigger DB-saturation 500s on POST /rest/v1/loop_heartbeats. The beat is pure recency-of-latest liveness, so one row per minute per source is sufficient and should be enforced authoritatively at the DB, not by a leaky best-effort read guard.

## Problem (from Control Tower signature `supabase-logs:6f16957ed72e1f38`)
recordFeedDelivery() (src/lib/control-tower/error-feed.ts:268) guards feed beats with a per-warm-instance in-memory map plus a non-atomic SELECT-then-INSERT recency check. Under the ~175/sec Vercel drain firehose across many concurrent/cold serverless instances, concurrent invocations all SELECT-miss before any beat is visible and all INSERT — observed 15,508 feed:vercel beats in the 06-23 13:00-14:00 hour (vs intended <=60/hr), whose insert storm momentarily saturated the DB and produced 99 POST /rest/v1/loop_heartbeats 500s (signature supabase-logs:6f16957ed72e1f38).

**Likely target:** `src/lib/control-tower/error-feed.ts (recordFeedDelivery) + a supabase/migrations/*.sql adding a UNIQUE partial index on loop_heartbeats(loop_id, date_trunc('minute', ran_at)) where kind='feed', with the insert switched to ON CONFLICT DO NOTHING`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:**
- `supabase/migrations/20260706130000_feed_beat_atomic_throttle.sql` — dedups existing same-minute `feed` beats, then creates the UNIQUE partial index `loop_heartbeats_feed_minute_uidx on (loop_id, (date_trunc('minute', ran_at at time zone 'UTC'))) where kind='feed'`, plus the `record_feed_beat(p_loop_id text)` RPC (`INSERT … ON CONFLICT DO NOTHING`). Index expression uses `AT TIME ZONE 'UTC'` so `date_trunc` is IMMUTABLE (indexable); the RPC's `ON CONFLICT` target matches it exactly so the index is the inferred arbiter. Apply: `scripts/apply-feed-beat-throttle-migration.ts`.
- `src/lib/control-tower/error-feed.ts` (`recordFeedDelivery`) — dropped the non-atomic `SELECT`-recency-then-`INSERT` guard; now marks the in-memory fast-path map *before* the call and inserts via `admin.rpc("record_feed_beat", …)`. Same-minute racers across cold instances collapse to one row at the DB.
- Brain pages updated: [[../tables/loop_heartbeats]] (gotcha + Migration), [[../libraries/control-tower]] (`recordFeedDelivery` entry).

> **Gated:** the migration must be applied to prod by the owner — `npx tsx scripts/apply-feed-beat-throttle-migration.ts` (the apply-script self-smoke-tests that 2 same-minute calls → 1 row).

## Verification
- After applying the migration, run `npx tsx scripts/apply-feed-beat-throttle-migration.ts` → expect `✓ applied …` and `✓ record_feed_beat: 2 same-minute calls → 1 row (atomic ON CONFLICT DO NOTHING)`.
- In the DB, confirm the index exists: `select indexname from pg_indexes where tablename='loop_heartbeats' and indexname='loop_heartbeats_feed_minute_uidx'` → expect one row.
- Probe the live feed volume after deploy: `select date_trunc('hour', ran_at) h, count(*) from loop_heartbeats where loop_id='feed:vercel' group by 1 order by 1 desc limit 3` → expect ≤60 beats/hour (was 15,508/hr at the storm), and at most one row per `date_trunc('minute', ran_at at time zone 'UTC')`.
- On the [[../dashboard/control-tower]] error panels, the `vercel` / `supabase-logs` / `client` tiles stay **green "connected"** through a drain burst — and no new `error_events` row / `loop_alert` opens for signature `supabase-logs:6f16957ed72e1f38` (no `POST /rest/v1/loop_heartbeats` 500s).

> Authored by the box Repair Agent from Control Tower signature `supabase-logs:6f16957ed72e1f38` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
