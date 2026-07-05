# libraries/commerce__fraud

The **Display** half of the commerce SDK for fraud posture — one entity-named read that rolls the orchestrator's fraud discriminators into a single view.

**File:** `src/lib/commerce/fraud.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 3 · **Depends on:** [[../tables/fraud_cases]] · [[customer-fraud-status]]

## Why this exists

Consolidates the historical `from("customer_fraud_status"` posture reads (previously spread across `src/lib/customer-fraud-status.ts` + per-surface fetches) into one entity-named Display op. The orchestrator's gate reads TWO discriminators today (any `confirmed_fraud` status OR any `amazon_reseller` rule_type); the SDK surfaces both in one call so the block decision is ONE read away.

Ships with zero call-site consumers — the M3 harness compares parity before any surface migrates.

## Exports

- **`getFraudPosture(workspaceId, customerId)`** → `FraudPostureView` — the customer's rolled fraud posture: `is_confirmed_fraud`, `is_amazon_reseller`, `should_block`, `block_reason`, plus the underlying `cases` array for evidence-render. Reads `fraud_cases` where the customer id appears in `customer_ids`.

Type re-exports: `FraudView`, `FraudPostureView`.

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__chargeback]] · [[commerce__customer]]
