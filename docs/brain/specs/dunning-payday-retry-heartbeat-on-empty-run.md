# Dunning payday-retry cron: emit Control Tower heartbeat on empty (no-due-cycle) runs ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/inngest/dunning.ts::real-bug`
**Repair-signature:** `loop:dunning-payday-retry-cron`

Make the dunning-payday-retry-cron emit its Control Tower heartbeat on every run, including runs that find no retryable dunning cycles, so the freshness/never-fired monitor stops false-flagging a healthy hourly cron as 'registered but never firing' during normal quiet dunning periods. Mirror the already-shipped empty-path heartbeat in deliver-pending-send.ts, ticket-csat.ts, and abandoned-cart.ts.

## Problem (from Control Tower signature `loop:dunning-payday-retry-cron`)
src/lib/inngest/dunning.ts gates its only emitCronHeartbeat('dunning-payday-retry-cron') behind work being found: the `if (cycles.length === 0) return { status: 'no_cycles_to_retry' }` early return at line 874 fires BEFORE the emit-heartbeat step at lines 1013-1015. The cron runs hourly (0 * * * *) with a 2h liveness window in registry.ts, but during windows with no dunning_cycles in status='retrying' & next_retry_at <= now() it returns early and writes no loop_heartbeats row. Over 16h of no due cycles it has emitted 0 beats all-time, so control-tower-monitor's never_fired branch (monitor.ts:248) reports the tile RED with 'Inngest is not invoking it' — even though the cron is firing on schedule. Sibling crons deliver-pending-send.ts (line 42) and ticket-csat.ts (line 98) already beat on their empty/idle path; dunning must match.

**Likely target:** `src/lib/inngest/dunning.ts`

## Phase 1 — close it ✅ (build #248 merged — heartbeat now in try/finally, fires on the no_active_cycles path)
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- ✅ Re-trigger the originating condition (signature `loop:dunning-payday-retry-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:dunning-payday-retry-cron` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
