# libraries/commerce__fraud

Fraud case operations in the Commerce SDK.

**File:** `src/lib/commerce/fraud.ts`

**Status:** Phase 1 surface declared (Phase 1 complete). Implementations arrive in M2b/M2c per [[../reference/commerce-sdk-inventory.html]].

## Exports

**`export type { FraudView }`**
- Canonical fraud case view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

The orchestrator bails on any `status='confirmed_fraud'` or `rule_type='amazon_reseller'` — the Display op carries `status` + `rule_type` so upstream gates stay one read away.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../tables/fraud_cases]] — Fraud case table schema.
[[./types]] — Commerce SDK type definitions.
