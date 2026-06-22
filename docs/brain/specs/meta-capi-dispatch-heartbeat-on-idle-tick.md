# Meta CAPI dispatch cron must beat on idle ticks (no-sinks early-return skips the heartbeat) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] (follows [[../specs/control-tower-complete-coverage]]; same fix class as [[../specs/cron-heartbeat-on-idle-tick]]) · **Repair-signature:** `loop:meta-capi-dispatch-cron` · **Verdict:** real-bug

Make meta-capi-dispatch-cron emit its Control Tower heartbeat on every tick, including idle ticks where there are no active meta_capi sinks, so a healthy-but-idle loop reads green (produced:{sinks:0}) instead of red never_fired. The heartbeat means 'Inngest invoked me' independent of whether there was work; move emitCronHeartbeat so it is reached on all return paths, restoring the liveness contract the early-return currently violates.

## Problem (from Control Tower signature `loop:meta-capi-dispatch-cron`)
src/lib/inngest/meta-capi-dispatch.ts:53 early-returns `if (sinks.length === 0) return { sinks: 0 };` before the emit-heartbeat step at lines 336-338, so on every idle tick (prod active meta_capi event_sinks = 0) the cron runs but never beats. With 0 all-time loop_heartbeats and the deploy past the 10m cadence+grace window, monitor.ts:236-248 trips never_fired even though the cron is correctly registered (registered-functions.ts:180) and served and invoked every minute. Identical to the already-fixed cron-heartbeat-on-idle-tick sibling.

**Likely target:** `src/lib/inngest/meta-capi-dispatch.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:meta-capi-dispatch-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:meta-capi-dispatch-cron` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
