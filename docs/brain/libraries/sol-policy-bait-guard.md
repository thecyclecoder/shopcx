# libraries/sol-policy-bait-guard

Machine gate the worker runs on Sol's DRAFT `first_reply` before the customer send fires. Phase 2 of [[../specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]] — the deterministic backstop that pairs with the mandatory policy review + no-out-of-policy-bait rules on [[./ticket-directions]] and the [[../tables/policies]] `How Sol uses this` block.

**File:** `src/lib/sol-policy-bait-guard.ts`

## Exports

### `assessSolReplyBaitRisk` — function

```ts
function assessSolReplyBaitRisk(ctx: {
  contextSummary: string;
  plan?: Record<string, unknown> | null;
  firstReply: string;
}): { ok: true } | {
  ok: false;
  kind: "out_of_policy_promise" | "multiple_remedies_offered";
  reason: string;
  matched_phrase: string;
}
```

Pure function, no dependencies, no model call, no DB read — deterministic regex over the reply text + Sol's own `context_summary` verdict. Two signals block a send:

1. **`multiple_remedies_offered`** — the reply stacks multiple remedies in one turn (`two returns`, `both prepaid labels`, `a return for each order`, `one for each of the two renewals`). Fires regardless of the declared verdict — the returns policy caps at ONE MBG return per customer for life, so the offer itself is a bait. Derived-from-ticket 87ce35a1 (Sol offered a customer two coffee-subscription returns). **Split-refund reconciliation exemption (ticket f2d898c9, mary arditi SC134282, 2026-08-21):** the "two refunds"-count sub-pattern is skipped when the reply is DESCRIBING refunds already posted to the ledger for ONE order — a partial + completion that together total the single return's refund. Detected by `isDescribingCompletedSplitRefund(reply)`, which requires (a) NO multi-order marker (`each order`, `both orders`, `two orders`, `the other order`, …), (b) NO forward-looking refund verb (`I'll issue`, `we'll process`, `happy to refund`, …), and (c) AT LEAST ONE completed-refund marker (`was refunded`, `has been refunded`, `already posted`, `fully refunded`, `partial and completion`, `split refund`, `posted in two parts`, …) OR an arithmetic sum reconciliation (`$5.01 + $49.33 = $54.34` — three dollar amounts where two sum to the third within a cent). The other three sub-patterns (`both … can be`, `a return for each order`, `one for each of the two renewals`) are inherently multi-order or forward-looking and never qualify. A future-tense offer that happens to sum-reconcile is still blocked; a multi-order shape that sneaks in past-tense wording is still blocked.
2. **`out_of_policy_promise`** — Sol's `context_summary` matches an out-of-policy marker (`out-of-policy`, `not eligible`, `categorically denied`, `cannot honor`, `renewals not eligible`, …) but the reply still promises a remedy (`I'll issue a refund`, `we'll set up a return`, `here's your prepaid label`, `let me expedite`). The reply mismatches the verdict — the customer never sees the baited turn.

3. **`unverified_remedy_promise`** (2026-08-12) — the caller passes `customerIdentified: false` (no account resolved; the inbound address matched nothing, or only a stub the webhook minted) and the reply still promises a remedy. Fires regardless of verdict, like signal 1. **Why it was needed:** the other two both assume we KNOW something — one needs a declared out-of-policy verdict, the other a stacked-remedy shape. Neither catches a promise made under total IGNORANCE, which is the more dangerous case: eligibility is *unknown* rather than known-bad. Ticket 879dd36b — *"cancelling your deliveries and processing your refund are both things we can absolutely take care of"* — written to someone we could not find. That refund might have been a renewal (categorically denied), outside the 30-day window, not their first order (MBG is first-order-only), or their one lifetime return already spent. Acknowledging and asking to identify them is never blocked; only the promise is. Omitting the flag defaults to `true`, so existing callers are unchanged.

**Capability assertions count as promises.** The original `PROMISE_PATTERNS` all matched a COMMITMENT (`I'll issue…`, `you'll receive…`, `here is your…`). 879dd36b used a capability claim instead — *"…are both things we can absolutely take care of"* — which promises just as hard and matched none of them. Three patterns now cover that shape (both word orders, plus `happy to issue…`), each requiring a remedy noun nearby so ordinary helpfulness (*"we can take a look at that"*) is untouched.

An in-policy reply that names the disallowed outcome AS DISALLOWED and offers the sanctioned alternative (`subscription renewals aren't eligible for return, but you can pause, skip, or cancel from your account`) **passes** the guard — the block is only for baited promises. Empty replies pass (nothing to send).

**Called by:** `runTicketHandleJob` in [[../../scripts/builder-worker]] — the check runs AFTER `writeDirection` succeeds (so Sol's reasoning is durably preserved for grader/coach visibility) and BEFORE `deliverTicketMessage` fires. A block writes the reason + matched phrase + draft reply body to the job's `log_tail` so a human can re-draft via the Improve tab; the Direction is never rolled back.

## Regex sets (kept conservative on purpose)

- `OUT_OF_POLICY_MARKERS` — phrase set that must appear in Sol's `context_summary` for the promise-check to fire. Deliberately conservative — a fuzzy phrasing means the guard doesn't fire, and an in-policy reply ships (same as pre-Phase-2 behavior). A false positive would suppress a legitimate reply, so the bar for a marker match is a phrase that unambiguously says "denied by policy".
- `PROMISE_PATTERNS` — first-person action verb + a remedy noun (`I'll issue a refund`, `we'll send a prepaid label`, `here is your prepaid label`, `let me process your refund`). An in-context REFERENCE to policy without a promise doesn't match, so an in-policy explanation still ships.
- `MULTIPLE_REMEDY_PATTERNS` — structural absurdity signals that fire regardless of verdict (`two returns`, `both returns`, `a return for each order`, `one for each of the two renewals`). The first sub-pattern (`TWO_REFUNDS_COUNT_PATTERN`, the `two|2 + refunds/returns/labels` count) is exempted for split-refund reconciliations via `isDescribingCompletedSplitRefund` — see signal 1 above; the other three never qualify.
- `COMPLETED_REFUND_MARKERS` / `MULTI_ORDER_MARKERS` / `FUTURE_REFUND_VERBS` / `containsSumReconciliation` — the four supporting predicates behind the split-refund exemption. Deliberately narrow past-tense verbs (`was refunded`, `has been posted`, `already refunded`, `partial and completion`, `split refund`) plus a three-dollar-amount sum reconciliation. Any multi-order marker or forward-looking refund verb short-circuits the exemption.

## Tests

`src/lib/sol-policy-bait-guard.test.ts` — unit tests including the named-failing-state coffee-return case (Phase 2 verification), the out-of-policy + return promise case, the in-policy pass-through case, the out-of-policy + alternative-only pass-through case, the both-signals-present case (structural signal wins), the `unverified_remedy_promise` set (ticket 879dd36b), and the split-refund reconciliation exemption set (ticket f2d898c9: describing-not-offering PASSES; a future-tense two-refunds offer that happens to sum-reconcile is STILL blocked; a multi-order shape with past-tense wording is STILL blocked).

Run: `npx tsx --test src/lib/sol-policy-bait-guard.test.ts`

---

**Sibling guard:** [[sol-outcome-claim-guard]] — the send guard also runs a claim-vs-DB check that blocks a reply asserting an outcome whose backing [[../tables/ticket_required_outcomes]] row is not `status='verified'`. Both guards fire in sequence at the same builder-worker wire-in point (policy-bait first, outcome-claim second); a block from either routes to the Improve tab.

[[../README]] · [[./ticket-directions]] · [[sol-outcome-claim-guard]] · [[../tables/policies]] · [[../tables/ticket_required_outcomes]] · [[../specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]] · [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../functions/cs]] · [[../../CLAUDE]]
