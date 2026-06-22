# Allergy/safety override: escalate to a human; never auto-refund without a return ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `46471a76-3c9b-4f11-b171-4ca2ff6934d9`

Amend the active exchanges policy (policies table, slug='exchanges') Allergy Override so an allergy/medical-reaction report ESCALATES to a human for safety review instead of authorizing a same-turn, no-clarification cash refund. Current text — 'Allergy/safety override — replacement OR refund, same turn, no clarification' and 'HIGHEST PRIORITY. Replacement OR refund same turn' — let executeSonnetDecision fire a direct_action partial_refund of $64.91 to the card with no return, no refund-playbook routing, and no escalation. Align with refund.md (no cash refund to card without a return) and sonnet_prompt #e0147885 'Tickets are anomalies' (safety-critical detail -> action_type='escalate', do NOT pre-commit a refund/replacement). New behavior: (a) genuine allergy/medical reaction on a RECEIVED order -> acknowledge the safety concern + action_type='escalate' for human review; never auto-issue a cash refund; (b) the replacement-chosen path keeps prepaid-return + refund_amount=0 as today; (c) any cash refund (including unwanted-renewal disputes) goes through the refund playbook, which requires a return on a fulfilled order and voids/cancels an UNFULFILLED order rather than refunding-to-card; (d) close the return-required-matrix gap by defining the refund-chosen allergy path (no refund-to-card without a return).

## Problem (from ticket `46471a76-3c9b-4f11-b171-4ca2ff6934d9`)
Ticket 46471a76 (Myra Eppright) reported the May 23 product made her 'deathly ill'. The orchestrator treated her UNWANTED June 20 renewal (SC133069, $64.91, unfulfilled — never shipped) as an 'allergy refund', issued a direct partial_refund to card with no return and no refund-playbook, told her twice 'our team is reviewing / someone will be in touch' while never escalating (escalation_reason null), and closed the ticket. The genuine safety case was never human-reviewed, cash moved with no return, and the refund hit the order she never received.

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the ticket scenario → confirm the fixed behavior, and that the ticket that surfaced it would now be handled correctly.

> Authored by the box Improve agent from ticket `46471a76-3c9b-4f11-b171-4ca2ff6934d9`. Commission the build from the Roadmap board (owner = cs).
