# Scope the tickets-awaiting-decision work probe to handler-driving messages ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts (fetchinlineagentstate → tickets-awaiting-decision branch, lines 523-534)::monitor-false-positive`
**Repair-signature:** `loop:unified-ticket-handler`

Narrow the Control Tower `tickets-awaiting-decision` work probe so it only counts inbound customer messages that actually drive unified-ticket-handler, eliminating false idle_while_work reds caused by CSAT-reopen and other human-routed inserts that never emit ticket/inbound-message.

## Problem (from Control Tower signature `loop:unified-ticket-handler`)
The loop alert fired idle_while_work (work=1, 0 successful runs / 0 beats of any kind in 120m) on a healthy handler that beats on every invocation. The monitor's tickets-awaiting-decision probe (monitor.ts:523-534) counts ALL inbound/customer ticket_messages with no AI-handled / event-emitting filter, so a single CSAT-reopen note (csat/[ticketId]/route.ts:82-97 — inserts an inbound customer message, reopens the ticket, routes to a human, no ticket/inbound-message event) over-counts as decision-agent work and trips the tile red. ai:orchestrator shares the same signal and the same false positive.

**Likely target:** `src/lib/control-tower/monitor.ts (fetchInlineAgentState → tickets-awaiting-decision branch, lines 523-534)`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:unified-ticket-handler`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:unified-ticket-handler` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
