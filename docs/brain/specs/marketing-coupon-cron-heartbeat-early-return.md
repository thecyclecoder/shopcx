# marketing-coupon-auto-disable cron must beat on the no-work path ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/inngest/marketing-coupon-cron.ts::real-bug`
**Repair-signature:** `loop:marketing-coupon-auto-disable`

Make the marketing-coupon-auto-disable cron emit its Control Tower heartbeat on every successful run, including the no-work (`due.length === 0`) path, so a healthy-but-idle cron is never mis-flagged registered_not_firing. While here, grep the other control-tower-complete-coverage crons for the same early-return-before-emit-heartbeat shape and fix any siblings.

## Problem (from Control Tower signature `loop:marketing-coupon-auto-disable`)
In src/lib/inngest/marketing-coupon-cron.ts the `emit-heartbeat` step (lines 64-67) is placed after `if (due.length === 0) return { disabled: 0 };` (line 46). With 0 active-coupon campaigns the cron always returns early and never emits a heartbeat, so loop_heartbeats has 0 rows for marketing-coupon-auto-disable despite Inngest invoking it daily at 10:00 UTC (verified: sibling 0 10 * * * crons beat at 2026-06-22T10:00 UTC; the implicated cron did not). The Control Tower watchdog correctly reads 0 beats past its 26h window and opens a false-RED registered_not_firing loop alert (loop_id=marketing-coupon-auto-disable, opened 2026-06-23T04:00 UTC).

**Likely target:** `src/lib/inngest/marketing-coupon-cron.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:** removed the `if (due.length === 0) return { disabled: 0 };` early return in `src/lib/inngest/marketing-coupon-cron.ts` so the run always falls through to the `emit-heartbeat` step (the disable loop is a no-op on an empty `due`, so the no-work run now beats with `produced = { disabled: 0, total_due: 0 }`). Updated [[../inngest/marketing-coupon-cron]] to document the cron trigger + always-beats behavior. `npx tsc --noEmit` clean.

**Siblings fixed (same early-return-before-emit-heartbeat shape, while here):**
- `daily-analysis-report-cron.ts` — dropped `if (!workspaces.length) return …`.
- `klaviyo-engagement-sync.ts` — dropped `if (!workspaces?.length) return …`.
- `meta-capi-dispatch.ts` — dropped `if (sinks.length === 0) return …`.
- `review-tagging.ts` — dropped `if (!reviews.length) return …`.
- `crisis-campaign.ts` — dropped `if (crises.length === 0) return …`.
- `delivery-audit.ts` — dropped `if (workspaces.length === 0) return …`.
- `sonnet-prompt-auto-review.ts` — dropped `if (!workspaces.length) return …`.
- `daily-order-snapshot.ts` (`daily-order-snapshot-self-heal`) — guarded the `step.sendEvent("rerun", …)` behind `flagged.length > 0` instead of early-returning, so the heartbeat still fires.
- `creative-finder.ts` + `brain-index-refresh.ts` — wrapped the body in an IIFE that returns the result on every path (incl. the config-missing skips `no_adlibrary_key` / `GitHub not configured`) so the trailing `emit-heartbeat` step always runs.

In every case the loops no-op on the empty set, so the heartbeat now fires on the no-work path with an accurate zero-count `produced`.

## Verification
- On the Control Tower tile for loop `marketing-coupon-auto-disable`, after the next `0 10 * * *` daily run (10:00 UTC) with 0 active-coupon campaigns due → expect a fresh `loop_heartbeats` row (`loop_id='marketing-coupon-auto-disable'`, `kind='cron'`, `ok=true`, `produced={"disabled":0,"total_due":0}`) and the tile stays **green** (no `registered_not_firing` loop alert opened).
- Probe `select loop_id, ran_at, produced from loop_heartbeats where loop_id='marketing-coupon-auto-disable' order by ran_at desc limit 1` after the run → expect a row dated within the last 26h (was previously 0 rows).
- Re-trigger the originating condition (signature `loop:marketing-coupon-auto-disable`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.
- For each fixed sibling cron (e.g. `creative-finder-daily-cron`, `brain-index-refresh`, `crisis-daily-campaign`, `delivery-nightly-audit`), force a no-work run (or wait for its next cron tick with no eligible rows) → expect a fresh `loop_heartbeats` row for that `loop_id` even though it did 0 work.

> Authored by the box Repair Agent from Control Tower signature `loop:marketing-coupon-auto-disable` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
