# Scope the tickets-awaiting-decision work probe to handler-driving messages ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts (fetchinlineagentstate → tickets-awaiting-decision branch, lines 523-534)::monitor-false-positive`
**Repair-signature:** `loop:unified-ticket-handler`

Narrow the Control Tower `tickets-awaiting-decision` work probe so it only counts inbound customer messages that actually drive unified-ticket-handler, eliminating false idle_while_work reds caused by CSAT-reopen and other human-routed inserts that never emit ticket/inbound-message.

## Problem (from Control Tower signature `loop:unified-ticket-handler`)
The loop alert fired idle_while_work (work=1, 0 successful runs / 0 beats of any kind in 120m) on a healthy handler that beats on every invocation. The monitor's tickets-awaiting-decision probe (monitor.ts:523-534) counts ALL inbound/customer ticket_messages with no AI-handled / event-emitting filter, so a single CSAT-reopen note (csat/[ticketId]/route.ts:82-97 — inserts an inbound customer message, reopens the ticket, routes to a human, no ticket/inbound-message event) over-counts as decision-agent work and trips the tile red. ai:orchestrator shares the same signal and the same false positive.

**Likely target:** `src/lib/control-tower/monitor.ts (fetchInlineAgentState → tickets-awaiting-decision branch, lines 523-534)`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:** `src/lib/control-tower/monitor.ts` `fetchInlineAgentState` → `tickets-awaiting-decision` branch now counts only handler-driving inbound-customer messages. It subtracts inbound-customer `ticket_messages` whose parent ticket carries the `csat:reopened` tag — the CSAT-reopen path (`src/app/api/csat/[ticketId]/route.ts:82-97`) inserts an inbound customer message, reopens the ticket, routes it to a human, and emits NO `ticket/inbound-message` event, so the handler legitimately never beats on it. Implemented as a NULL-safe two-query subtraction (`all − csat:reopened`, clamped at 0) rather than a negated array filter, so tickets with NULL/empty `tags` always count. The fix is at the probe layer, so both loops on this signal — `unified-ticket-handler` and `ai:orchestrator` — get it. Doc comments updated in `registry.ts` (`InlineWorkSignalId`) and `docs/brain/libraries/control-tower.md`. Monitor-only; no schema/runtime-path change.

## Verification
- In `src/lib/control-tower/monitor.ts`, the `tickets-awaiting-decision` branch runs two `ticket_messages` head-counts (`all` and `tickets!inner` filtered by `.contains("tickets.tags", ["csat:reopened"])`) and returns `Math.max(0, all − reopened)` → confirm the diff matches.
- `npx tsc --noEmit` → expect clean (no new errors).
- On Control Tower (`/dashboard/control-tower`), in a window whose ONLY inbound-customer `ticket_messages` are CSAT-reopen notes (ticket tagged `csat:reopened`) with 0 handler beats → expect the `unified-ticket-handler` and `ai:orchestrator` tiles stay GREEN (work probe returns 0, no `idle_while_work` red, no new `loop_alerts` row).
- In a window with a genuine channel inbound (email/sms/portal/widget/journey — fires `ticket/inbound-message`) and 0 successful decision beats → expect the tile still goes RED (`idle_while_work` preserved for a real outage).
- Re-trigger the originating condition (signature `loop:unified-ticket-handler`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:unified-ticket-handler` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
