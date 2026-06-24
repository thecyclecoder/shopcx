# Atomic per-minute throttle for feed:<source> liveness beats (kill the Vercel-drain write storm) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/control-tower/error-feed.ts (recordfeeddelivery) + a supabase/migrations/*.sql adding a unique partial index on loop_heartbeats(loop_id, date_trunc(minute, ran_at)) where kind=feed, with the insert switched to on conflict do nothing::real-bug`
**Repair-signature:** `supabase-logs:6f16957ed72e1f38`
**Repair-signature:** `cluster:repair`
**Repair-signature:** `supabase-logs:bc3c30231145bed6`
**Repair-signature:** `supabase-logs:1fd35d3ca23f421a`

Make the feed-delivery liveness beat throttle atomic so a Vercel log-drain burst can no longer storm loop_heartbeats and trigger DB-saturation 500s on POST /rest/v1/loop_heartbeats. The beat is pure recency-of-latest liveness, so one row per minute per source is sufficient and should be enforced authoritatively at the DB, not by a leaky best-effort read guard.

## Problem (from Control Tower signature `supabase-logs:6f16957ed72e1f38`)
recordFeedDelivery() (src/lib/control-tower/error-feed.ts:268) guards feed beats with a per-warm-instance in-memory map plus a non-atomic SELECT-then-INSERT recency check. Under the ~175/sec Vercel drain firehose across many concurrent/cold serverless instances, concurrent invocations all SELECT-miss before any beat is visible and all INSERT — observed 15,508 feed:vercel beats in the 06-23 13:00-14:00 hour (vs intended <=60/hr), whose insert storm momentarily saturated the DB and produced 99 POST /rest/v1/loop_heartbeats 500s (signature supabase-logs:6f16957ed72e1f38).

**Likely target:** `src/lib/control-tower/error-feed.ts (recordFeedDelivery) + a supabase/migrations/*.sql adding a UNIQUE partial index on loop_heartbeats(loop_id, date_trunc('minute', ran_at)) where kind='feed', with the insert switched to ON CONFLICT DO NOTHING`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `supabase-logs:6f16957ed72e1f38`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `supabase-logs:6f16957ed72e1f38` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
