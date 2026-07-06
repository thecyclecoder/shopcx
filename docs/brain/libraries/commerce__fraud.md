# libraries/commerce__fraud

Fraud case read and mutation operations in the Commerce SDK.

**File:** `src/lib/commerce/fraud.ts`

**Status:** Display operations shipped (Phase 3 complete). Mutation operations planned per [[../reference/commerce-sdk-inventory.html]].

## Exports

### Display (reads)

**`getFraudPosture(workspaceId, customerId) → FraudView`**
- Retrieves fraud context for a customer (if any fraud flags).
- Per [[../reference/commerce-sdk-inventory.html]], FraudView includes evidence, linked accounts/orders/subs, and status.
- Carries `status` + `rule_type` so upstream gates (orchestrator, dunning, chargeback) stay one read away.
- Returns empty if no fraud flags, non-empty if fraud is confirmed or suspected.

### Types

**`export type { FraudView }`**
- Canonical fraud case view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

The orchestrator bails on any `status='confirmed_fraud'` or `rule_type='amazon_reseller'` — the Display op carries `status` + `rule_type` so upstream gates stay one read away.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../tables/fraud_cases]] — Fraud case table schema.
[[./types]] — Commerce SDK type definitions.
