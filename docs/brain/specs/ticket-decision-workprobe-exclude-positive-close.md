# Control Tower: scope tickets-awaiting-decision work probe past positive-close/fraud short-circuits ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts (the tickets-awaiting-decision case in fetchinlineagentstate — exclude inbound messages on tickets closed without an orchestrator beat, e.g. add a closed-ticket subtraction alongside the existing csat:reopened one; a still-open ticket with no beat keeps counting so real outages still alert).::monitor-false-positive`
**Repair-signature:** `loop:ai:orchestrator`

Tighten the ai:orchestrator idle_while_work assertion so it stops false-paging on inbound customer messages that the unified-ticket-handler resolves WITHOUT invoking the orchestrator. The work probe is a proxy for orchestrator demand and currently over-counts: it treats every inbound customer message as a decision the orchestrator must produce, subtracting only csat:reopened, but several handler paths (positive-close, fraud-gate, chargeback) legitimately close the ticket and skip callSonnetOrchestratorV2. Extend the subtraction the way control-tower-ticket-decision-workprobe-scope already did for csat:reopened, monitor-only, so a lone 'Thank you' in a quiet window no longer flips the tile red.

## Problem (from Control Tower signature `loop:ai:orchestrator`)
monitor.ts fetchInlineAgentState's 'tickets-awaiting-decision' case (~line 523-553) counts inbound direction=inbound author_type=customer messages in-window minus csat:reopened. unified-ticket-handler.ts:1635 returns {status:'positive_close'} (and the fraud/chargeback gates at ~1654 close the ticket) BEFORE reaching callSonnetOrchestratorV2:1760, so these messages never drive an ai:orchestrator beat. On 2026-06-24T04:00Z a single positive-close 'Thank you' (msg cb3c2d62 on closed ticket 8fa1433e) was the only in-window inbound, yielding work=1, okCount=0 → a false idle_while_work red on a loop whose last ok beat was 01:53.

**Likely target:** `src/lib/control-tower/monitor.ts (the 'tickets-awaiting-decision' case in fetchInlineAgentState — exclude inbound messages on tickets closed without an orchestrator beat, e.g. add a closed-ticket subtraction alongside the existing csat:reopened one; a still-open ticket with no beat keeps counting so real outages still alert).`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:ai:orchestrator`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:ai:orchestrator` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
