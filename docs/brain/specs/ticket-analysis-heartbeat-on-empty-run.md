# Ticket-analysis cron: emit Control Tower heartbeat on empty (no-tickets) runs ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/inngest/ticket-analysis-cron.ts::real-bug`
**Repair-signature:** `loop:ticket-analysis-cron`

Make the ticket-analysis-cron emit its Control Tower heartbeat on every run, including no-ticket runs, so the freshness monitor stops false-flagging a healthy 30-min cron as dead during normal quiet periods — mirroring the already-shipped empty-path heartbeat in deliver-pending-send.ts, ticket-csat.ts, and abandoned-cart.ts.

## Problem (from Control Tower signature `loop:ticket-analysis-cron`)
src/lib/inngest/ticket-analysis-cron.ts gates its only emitCronHeartbeat behind work being found: the `if (!tickets.length) return { analyzed: 0, skipped: 0 }` early-return at lines 49-51 fires before the emit-heartbeat step at lines 87-89. With a */30 cadence and a 90-min liveness window (registry.ts:394), windows with no closed AI ticket whose last_analyzed_at is stale vs updated_at return early and write no loop_heartbeats row, so control-tower-monitor reports cron_freshness RED (last beat 2026-06-22T17:30:36Z, alert opened 19:15Z, ~3 empty runs) despite the cron firing on schedule.

**Likely target:** `src/lib/inngest/ticket-analysis-cron.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:ticket-analysis-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:ticket-analysis-cron` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
