# Fix ticket-analysis-cron Control Tower cadence/window mismatch (false cron_freshness red) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/registry.ts::monitor-false-positive`
**Repair-signature:** `loop:ticket-analysis-cron`

Correct the Control Tower registry's liveness assertion for the ticket-analysis-cron loop so it matches the loop's real */30 schedule, eliminating the recurring false cron_freshness red that fires ~15 min after every clean beat (15 of every 30 minutes the tile is wrongly red).

## Problem (from Control Tower signature `loop:ticket-analysis-cron`)
src/lib/control-tower/registry.ts:455 registers ticket-analysis-cron with expectedCadence='every 5 min (*/5 * * * *)' and livenessWindowMs=15*MIN, but the Inngest function (src/lib/inngest/ticket-analysis-cron.ts:25) is triggered '*/30 * * * *' (every 30 min) and the registry row sits under the '─ Every-30-min crons (window ~90 min) ─' header. monitor.ts:339-343 reds the tile when age(last beat) exceeds livenessWindowMs; with a 15-min window against a 30-min cadence the tile false-fires cron_freshness every cycle (e.g. last beat 2026-06-23T19:00:02Z → alert at 19:15, next real tick 19:30). The cron is healthy; only the monitor's expected cadence/window are wrong.

**Likely target:** `src/lib/control-tower/registry.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:ticket-analysis-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:ticket-analysis-cron` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
