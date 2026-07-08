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

1. **`multiple_remedies_offered`** — the reply stacks multiple remedies in one turn (`two returns`, `both prepaid labels`, `a return for each order`, `one for each of the two renewals`). Fires regardless of the declared verdict — the returns policy caps at ONE MBG return per customer for life, so the offer itself is a bait. Derived-from-ticket 87ce35a1 (Sol offered a customer two coffee-subscription returns).
2. **`out_of_policy_promise`** — Sol's `context_summary` matches an out-of-policy marker (`out-of-policy`, `not eligible`, `categorically denied`, `cannot honor`, `renewals not eligible`, …) but the reply still promises a remedy (`I'll issue a refund`, `we'll set up a return`, `here's your prepaid label`, `let me expedite`). The reply mismatches the verdict — the customer never sees the baited turn.

An in-policy reply that names the disallowed outcome AS DISALLOWED and offers the sanctioned alternative (`subscription renewals aren't eligible for return, but you can pause, skip, or cancel from your account`) **passes** the guard — the block is only for baited promises. Empty replies pass (nothing to send).

**Called by:** `runTicketHandleJob` in [[../../scripts/builder-worker]] — the check runs AFTER `writeDirection` succeeds (so Sol's reasoning is durably preserved for grader/coach visibility) and BEFORE `deliverTicketMessage` fires. A block writes the reason + matched phrase + draft reply body to the job's `log_tail` so a human can re-draft via the Improve tab; the Direction is never rolled back.

## Regex sets (kept conservative on purpose)

- `OUT_OF_POLICY_MARKERS` — phrase set that must appear in Sol's `context_summary` for the promise-check to fire. Deliberately conservative — a fuzzy phrasing means the guard doesn't fire, and an in-policy reply ships (same as pre-Phase-2 behavior). A false positive would suppress a legitimate reply, so the bar for a marker match is a phrase that unambiguously says "denied by policy".
- `PROMISE_PATTERNS` — first-person action verb + a remedy noun (`I'll issue a refund`, `we'll send a prepaid label`, `here is your prepaid label`, `let me process your refund`). An in-context REFERENCE to policy without a promise doesn't match, so an in-policy explanation still ships.
- `MULTIPLE_REMEDY_PATTERNS` — structural absurdity signals that fire regardless of verdict (`two returns`, `both returns`, `a return for each order`, `one for each of the two renewals`).

## Tests

`src/lib/sol-policy-bait-guard.test.ts` — 7 unit tests including the named-failing-state coffee-return case (Phase 2 verification), the out-of-policy + return promise case, the in-policy pass-through case, the out-of-policy + alternative-only pass-through case, and the both-signals-present case (structural signal wins).

Run: `npx tsx --test src/lib/sol-policy-bait-guard.test.ts`

---

**Sibling guard:** [[sol-outcome-claim-guard]] — the send guard also runs a claim-vs-DB check that blocks a reply asserting an outcome whose backing [[../tables/ticket_required_outcomes]] row is not `status='verified'`. Both guards fire in sequence at the same builder-worker wire-in point (policy-bait first, outcome-claim second); a block from either routes to the Improve tab.

[[../README]] · [[./ticket-directions]] · [[sol-outcome-claim-guard]] · [[../tables/policies]] · [[../tables/ticket_required_outcomes]] · [[../specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]] · [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../functions/cs]] · [[../../CLAUDE]]
