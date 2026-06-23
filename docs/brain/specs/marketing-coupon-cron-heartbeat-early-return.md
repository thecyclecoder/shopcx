# marketing-coupon-auto-disable cron must beat on the no-work path ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/inngest/marketing-coupon-cron.ts::real-bug`
**Repair-signature:** `loop:marketing-coupon-auto-disable`

Make the marketing-coupon-auto-disable cron emit its Control Tower heartbeat on every successful run, including the no-work (`due.length === 0`) path, so a healthy-but-idle cron is never mis-flagged registered_not_firing. While here, grep the other control-tower-complete-coverage crons for the same early-return-before-emit-heartbeat shape and fix any siblings.

## Problem (from Control Tower signature `loop:marketing-coupon-auto-disable`)
In src/lib/inngest/marketing-coupon-cron.ts the `emit-heartbeat` step (lines 64-67) is placed after `if (due.length === 0) return { disabled: 0 };` (line 46). With 0 active-coupon campaigns the cron always returns early and never emits a heartbeat, so loop_heartbeats has 0 rows for marketing-coupon-auto-disable despite Inngest invoking it daily at 10:00 UTC (verified: sibling 0 10 * * * crons beat at 2026-06-22T10:00 UTC; the implicated cron did not). The Control Tower watchdog correctly reads 0 beats past its 26h window and opens a false-RED registered_not_firing loop alert (loop_id=marketing-coupon-auto-disable, opened 2026-06-23T04:00 UTC).

**Likely target:** `src/lib/inngest/marketing-coupon-cron.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:marketing-coupon-auto-disable`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:marketing-coupon-auto-disable` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
