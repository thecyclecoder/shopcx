# Grace the ticket-analyzer work probe for its 30-min feeder cron ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts::monitor-false-positive`
**Repair-signature:** `loop:ai:ticket-analyzer`

Add a feeder-cadence grace to the tickets-awaiting-qc work probe so a closed AI ticket only counts as 'awaited but unserviced' after surviving at least one full ticket-analysis-cron cycle unprocessed, eliminating the between-ticks false positive while still catching a genuinely stuck analyzer. Monitor-only, no analyzer behavior change.

## Problem (from Control Tower signature `loop:ai:ticket-analyzer`)
The ai:ticket-analyzer tile went RED with idle_while_work ('silent while 1 item awaited it — 0 successful runs in the last 120m'), but the loop is healthy. The inline agent is fed by ticket-analysis-cron (every 30 min), yet the tickets-awaiting-qc work probe counts any closed AI ticket with last_analyzed_at=null updated within the 2h window, with no age gate vs the cron cadence. The 1 item (ticket 8cf8aee0-7a73-4c47-a1b1-683e95800f8e) closed at 20:33:55 — 3.8 min after the 20:30 cron tick and before the ~21:00 tick; the cron beats at 20:30/20:00/19:30 are all ok and ran idle (analyzed 0), so the agent legitimately had 0 beats. work>0 && okCount==0 was satisfied purely by a ticket caught between cron ticks, firing the alert ~15 min before any cron cycle could service it.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:ai:ticket-analyzer`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:ai:ticket-analyzer` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
