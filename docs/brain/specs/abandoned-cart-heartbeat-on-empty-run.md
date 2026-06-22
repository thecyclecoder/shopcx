# Abandoned-cart cron: emit Control Tower heartbeat on empty (no-due-carts) runs ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/inngest/abandoned-cart.ts::real-bug`
**Repair-signature:** `loop:abandoned-cart-reminder`

Make the abandoned-cart-reminder cron emit its Control Tower heartbeat on every run, including runs that find no due carts, so the freshness monitor stops false-flagging a healthy cron as dead during normal quiet periods.

## Problem (from Control Tower signature `loop:abandoned-cart-reminder`)
src/lib/inngest/abandoned-cart.ts gates its emitCronHeartbeat behind work being found: the `if (due.length === 0) return { sent: 0, scanned: 0 };` early return at line 130 fires BEFORE the emit-heartbeat step at lines 206-208. The cron runs every 10 min (*/10 * * * *) with a 40-min liveness window in registry.ts, but during off-peak windows with no abandoned carts it returns early and emits no loop_heartbeats row, so control-tower-monitor reports cron_freshness RED (observed: last beat 2026-06-22T16:40:04Z, alert opened 17:30 — 50 min of healthy-but-silent runs). Sibling crons deliver-pending-send.ts and ticket-csat.ts already beat on their empty path; abandoned-cart must match.

**Likely target:** `src/lib/inngest/abandoned-cart.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

Shipped: `src/lib/inngest/abandoned-cart.ts` — the `if (due.length === 0)` early-return now emits `emitCronHeartbeat("abandoned-cart-reminder", { ok: true, produced: { sent: 0, scanned: 0 } })` via a `step.run("emit-heartbeat")` before returning, matching the empty-path beat in `deliver-pending-send.ts` + `ticket-csat.ts`. Brain page `inngest/abandoned-cart.md` documents the idle-tick heartbeat. tsc clean.

## Verification
- Re-trigger the originating condition (signature `loop:abandoned-cart-reminder`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:abandoned-cart-reminder` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
