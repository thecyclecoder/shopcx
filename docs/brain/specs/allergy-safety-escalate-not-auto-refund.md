# Allergy/safety override: escalate to a human; never auto-refund without a return ✅

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `46471a76-3c9b-4f11-b171-4ca2ff6934d9`

Amend the active exchanges policy (policies table, slug='exchanges') Allergy Override so an allergy/medical-reaction report ESCALATES to a human for safety review instead of authorizing a same-turn, no-clarification cash refund. Current text — 'Allergy/safety override — replacement OR refund, same turn, no clarification' and 'HIGHEST PRIORITY. Replacement OR refund same turn' — let executeSonnetDecision fire a direct_action partial_refund of $64.91 to the card with no return, no refund-playbook routing, and no escalation. Align with refund.md (no cash refund to card without a return) and sonnet_prompt #e0147885 'Tickets are anomalies' (safety-critical detail -> action_type='escalate', do NOT pre-commit a refund/replacement). New behavior: (a) genuine allergy/medical reaction on a RECEIVED order -> acknowledge the safety concern + action_type='escalate' for human review; never auto-issue a cash refund; (b) the replacement-chosen path keeps prepaid-return + refund_amount=0 as today; (c) any cash refund (including unwanted-renewal disputes) goes through the refund playbook, which requires a return on a fulfilled order and voids/cancels an UNFULFILLED order rather than refunding-to-card; (d) close the return-required-matrix gap by defining the refund-chosen allergy path (no refund-to-card without a return).

## Problem (from ticket `46471a76-3c9b-4f11-b171-4ca2ff6934d9`)
Ticket 46471a76 (Myra Eppright) reported the May 23 product made her 'deathly ill'. The orchestrator treated her UNWANTED June 20 renewal (SC133069, $64.91, unfulfilled — never shipped) as an 'allergy refund', issued a direct partial_refund to card with no return and no refund-playbook, told her twice 'our team is reviewing / someone will be in touch' while never escalating (escalation_reason null), and closed the ticket. The genuine safety case was never human-reviewed, cash moved with no return, and the refund hit the order she never received.

## Phases
- ✅ **P1 — implement the fix** — amended the live `exchanges` policy (text + rules) so allergy/safety escalates instead of auto-refunding; landed the brain pages; gated on `npx tsc --noEmit`.

## What landed
- `scripts/update-exchanges-allergy-escalate.ts` — targeted, idempotent apply-script that amends the live `exchanges` policy row in place (anchored replacements + `rules` patch). **Requires owner approval to run against prod** (`npx tsx scripts/update-exchanges-allergy-escalate.ts`).
- `scripts/seed-policies-v1.ts` — exchanges section updated to the new text so the documented source-of-truth stays current.
- Policy changes: trigger #5 now escalates; Return-required matrix gained the refund/cash-chosen row (escalate; no refund-to-card without a return); § Allergy Override Priority rewritten to "acknowledge + escalate, never auto cash refund"; `rules.exchanges.allergy_override_priority` carries `action:"escalate"`; new `rules.exchanges.allergy_refund_requires_return:true`.
- Brain: [[../playbooks/replacement-order]] § Allergy/safety; [[../tables/policies]] gotchas.

## Verification
- **Run the apply-script (owner, one-tap):** `npx tsx scripts/update-exchanges-allergy-escalate.ts` → expect `✓ exchanges policy amended … allergy/safety now escalates`; re-run → expect `✓ exchanges policy already up to date — nothing to do` (idempotent).
- **DB probe:** `select internal_summary, rules from policies where slug='exchanges' and is_active and superseded_by is null` → expect the § Allergy Override Priority paragraph to say `action_type='escalate'` / "NEVER auto-issue a same-turn cash refund", the matrix to contain the "Allergy/safety (refund/cash chosen) → ESCALATE …" row, and `rules` to contain `exchanges.allergy_refund_requires_return=true` and `exchanges.allergy_override_priority.action='escalate'`.
- **Reproduce ticket 46471a76:** feed a fresh inbound "the product made me deathly ill" on a customer whose only recent order is an UNWANTED, unfulfilled renewal (mirror SC133069, $64.91) → expect the orchestrator decision to be `action_type='escalate'` with a non-null `escalation_reason` ("allergy/safety report — needs immediate review") and an empathetic acknowledgment, and **no** `direct_action` `partial_refund` to the card.
- **Replacement-chosen path unchanged:** allergy report where the customer asks for a replacement of a RECEIVED order → expect a prepaid return label + `refund_amount=0` (no cash to card).
- **Cash-refund routing:** any cash refund on the allergy ticket → expect it to go through the Refund playbook (return required on a fulfilled order; void/cancel on an unfulfilled one), never a same-turn refund-to-card.

> Authored by the box Improve agent from ticket `46471a76-3c9b-4f11-b171-4ca2ff6934d9`. Commission the build from the Roadmap board (owner = cs).
