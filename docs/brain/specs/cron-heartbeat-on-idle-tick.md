# Cron heartbeat must fire on idle ticks (early-return skips the beat) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] (follows [[../specs/control-tower-complete-coverage]] + [[../specs/control-tower-monitor-accuracy]]; corrects [[../specs/serve-unserved-crons]] which mis-diagnosed this loop) · **Repair-signature:** `loop:marketing-text-campaign-send-tick` · **Verdict:** real-bug

Make every heartbeat-instrumented cron beat on every tick, including idle/no-work ticks, so a healthy-but-idle cron reads green (produced:{sent:0}) instead of red never_fired. The heartbeat means 'Inngest invoked me' independent of whether there was work; move emitCronHeartbeat so it is reached on all return paths (emit before each early-return, or make the beat the last unconditional step), restoring the Control Tower liveness contract that an early-return currently violates.

## Problem (from Control Tower signature `loop:marketing-text-campaign-send-tick`)
marketing-text.ts:409 early-returns `if (due.length === 0) return { sent: 0 };` on every idle tick (prod pending recipients = 0), but emitCronHeartbeat is at the function end (line 637-639), so idle ticks never beat. Prod loop_heartbeats has 0 all-time beats for marketing-text-campaign-send-tick despite the cron being served (registered-functions.ts:205) and invoked every minute — tripping monitor.ts:236-248 never_fired. Sibling deliver-pending-send.ts:35 has the identical pattern (1 lone beat).

**Likely target:** `src/lib/inngest/marketing-text.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`. **Shipped:** the `due.length === 0` early-return in `marketing-text.ts` (send-tick) and the identical `messages.length === 0` early-return in `deliver-pending-send.ts` now each emit their own `emitCronHeartbeat(..., { ok: true, produced: { sent/delivered: 0 } })` step before returning, so an idle tick beats. Brain pages [[../inngest/marketing-text]] + [[../inngest/deliver-pending-send]] updated. (Broader sweep of the other ~45 heartbeat-instrumented crons for the same anti-pattern is out of scope here — these are the two the signal named.)

## Verification
- On prod `loop_heartbeats`, query `select count(*), max(ran_at) from loop_heartbeats where loop_id = 'marketing-text-campaign-send-tick'` after the next idle minute → expect a fresh row with `produced = {"sent":0}` (was 0 all-time beats before this fix).
- On prod `loop_heartbeats`, same query for `loop_id = 'deliver-pending-sends'` → expect a fresh `produced = {"delivered":0}` row each idle minute (was 1 lone beat).
- On the Control Tower dashboard, the `marketing-text-campaign-send-tick` + `deliver-pending-sends` tiles → expect green/live, not red `never_fired`.
- ✅ Re-trigger the originating condition (signature `loop:marketing-text-campaign-send-tick`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:marketing-text-campaign-send-tick` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
