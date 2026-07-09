# libraries/sol-move-dead-end-guard

Machine gate the worker runs on Sol's DRAFT reply just after the policy-bait guard, before the customer-facing send. Phase 3 of [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]] — the deterministic backstop that enforces the moved-customer-save invariants on [[./ticket-directions]].

**File:** `src/lib/sol-move-dead-end-guard.ts`

## Design invariants

Phase-3 enforces three rules on a move-signal ticket with an active subscription:

1. **Never dead-end as cancel.** A move signal ("I moved", "new address", "cancel, I moved") with an active subscription NEVER produces a cancel-only / no-redirect terminal reply. The customer must be offered the address-update save first (Phase 1 — `launch_journey_slug='shipping-address'`), never dead-ended into cancel or an "already shipped, can't redirect" terminal.
2. **Explicit cancel gets the self-service journey.** A customer who insists on cancel AFTER the move-save offer is handed the SELF-SERVICE Cancel Subscription journey — Sol never cancels for them and never terminates with "we'll cancel it now" or "your subscription is cancelled". The honest cancel path is `plan.launch_journey_slug='cancel-subscription'` + a reply that hands the link.
3. **Already-shipped pairs with an alternative.** An already-shipped order is acknowledged truthfully — but the acknowledgment MUST pair with an alternative (address update on future shipments, a $0 replacement to the new address, the self-service cancel link). A bare "already shipped, can't redirect" that terminates the interaction is the exact dead-end this guard blocks.

Same shape as [[./sol-policy-bait-guard]] — a pure function with no filesystem / network dependencies so the worker imports it cheaply and the tests seed inputs directly.

## Exports

### `SolMoveDeadEndContext` — interface

```ts
interface SolMoveDeadEndContext {
  intent: string;
  contextSummary: string;
  plan?: Record<string, unknown> | null;
  firstReply: string;
  hasActiveSubscription: boolean;
}
```

Input context for the assessment:
- **`intent`** — Sol's Direction.intent — one-line customer-intent distillation from the first-touch.
- **`contextSummary`** — Sol's Direction.context_summary — merged customer + subscription + order context.
- **`plan`** — Sol's Direction.plan — reserved for the escape-hatch check (`launch_journey_slug: 'cancel-subscription'` proves the reply is handing the self-service journey).
- **`firstReply`** — The DRAFT reply Sol wants to send to the customer.
- **`hasActiveSubscription`** — Whether this customer has at least one ACTIVE subscription. When false, the "never dead-end a move as cancel" invariant does not apply.

### `SolMoveDeadEndAssessment` — type

```ts
type SolMoveDeadEndAssessment =
  | { ok: true }
  | {
      ok: false;
      kind: 
        | "move_dead_ended_as_cancel"
        | "move_terminal_no_redirect_without_alternative"
        | "cancel_after_offer_without_self_service_handoff";
      reason: string;
      matched_phrase: string;
    }
```

Assessment result — `{ok: true}` when the reply is safe, `{ok: false, kind, reason, matched_phrase}` when the send must be blocked. Three kinds map to the invariants:
- **`move_dead_ended_as_cancel`** — Sol has an active-sub move ticket and her reply terminates in a cancel or "already shipped, can't redirect" without any escape hatch.
- **`move_terminal_no_redirect_without_alternative`** — Variant where the dead-end phrase is bare "can't redirect / nothing we can do" (the shipment ack without an alternative).
- **`cancel_after_offer_without_self_service_handoff`** — Explicit-cancel path detected (Sol's Direction has `plan.launch_journey_slug='cancel-subscription'`), but the reply's first-person verbs suggest Sol is cancelling FOR the customer instead of handing the link.

### `assessSolMoveDeadEndRisk` — function

```ts
function assessSolMoveDeadEndRisk(ctx: SolMoveDeadEndContext): SolMoveDeadEndAssessment
```

The core assessor — returns `{ok: true}` when the reply is safe to send, `{ok: false, …}` when the send must be blocked. Pure, no dependencies, no model call, no DB read — deterministic regex over the reply text + Sol's own `context_summary` and `intent`.

**Called by:** `runTicketHandleJob` in [[../../scripts/builder-worker]] — the check runs AFTER `writeDirection` succeeds (so Sol's reasoning is durably preserved for grader/coach visibility) and BEFORE `deliverTicketMessage` fires. A block writes the reason + matched phrase + draft reply body to the job's `log_tail` so a human can re-draft via the Improve tab; the Direction is never rolled back.

## Regex sets (kept conservative on purpose)

- **`MOVE_SIGNAL_MARKERS`** — signals in Sol's `intent` or `context_summary` that mark this ticket as a MOVE. Deliberately broad on the customer-language side — a false negative just means the guard doesn't fire (behavior falls back to the pre-Phase-3 send path), so the bar is intentionally low. Matches: "I've moved", "we've moved", "customer has moved", "just moved", "recently moved", "relocated", "relocated", "new address", "changed address", "address change", "moving to", "move, new address".
- **`DEAD_END_PATTERNS`** — reply phrases that terminate a move signal with a cancel-only or no-redirect dead-end. Intentionally narrow — matches a first-person termination ("we'll cancel", "your only option is to cancel") or bare "can't redirect" / "nothing we can do". Patterns: "we'll/I'll cancel your subscription", "your only option is to cancel", "your subscription has been cancelled", "already shipped, can't redirect", "can't redirect that order/shipment", "nothing we can do".
- **`ESCAPE_HATCH_PATTERNS`** — phrases that turn an acknowledgement into a save-path continuation instead of a dead-end. Broad and forgiving — a reply that gestures at ANY save-path continuation passes. Patterns: "update/confirm address", "address on file", "future shipments", "next shipment", "replacement", "ship another", "send a free replacement", "self-service cancel", "cancel link/journey", "here's the link".

## Tests

`src/lib/sol-move-dead-end-guard.test.ts` — unit tests covering the Phase-3 invariants: (1) move + active sub never dead-ends as cancel, (2) explicit cancel after offer hands the self-service journey (not Sol cancelling for them), (3) already-shipped is acknowledged but pairs with an alternative, (4) edge cases like false-negative move detection (guard doesn't fire, behavior falls back to pre-Phase-3 send path).

Run: `npx tsx --test src/lib/sol-move-dead-end-guard.test.ts`

## Related guards

[[sol-policy-bait-guard]] — sibling send guard that blocks out-of-policy promises. Both guards fire in sequence at the same builder-worker wire-in point (policy-bait first, move-dead-end second); a block from either routes to the Improve tab.

---

[[../README]] · [[./ticket-directions]] · [[./move-replacement-offer]] · [[./sol-policy-bait-guard]] · [[../lifecycles/ticket-lifecycle]] · [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]] · [[../functions/cs]] · [[../../CLAUDE]]
