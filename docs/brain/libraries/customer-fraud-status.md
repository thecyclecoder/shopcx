# libraries/customer-fraud-status

`getCustomerFraudStatus()` — orchestrator short-circuit check. Returns `confirmed_fraud` or `amazon_reseller` flag across the customer's link group.

**File:** `src/lib/customer-fraud-status.ts`

## File header

```
Customer fraud status helpers — used by the orchestrator's pre-flight
gate to refuse actions for any customer with fraud signal, and by the
get_fraud_cases data tool to give Sonnet visibility into open cases.
The gate (`shouldBlockOrchestrator`) returns true if ANY of:
1. any fraud_cases row with status='confirmed_fraud' (any rule_type)
2. any fraud_cases row with rule_type='amazon_reseller' (any status —
including 'open' — being flagged at all is enough to bail)
3. any of the customer's order shipping/billing addresses match an
active known_resellers row
See feedback_orchestrator_fraud_gate.md.
```

## Exports

### `getCustomerFraudStatus` — function

```ts
async function getCustomerFraudStatus(admin: SupabaseClient, workspaceId: string, customerId: string | null,) : Promise<FraudStatus>
```

### `shouldBlockOrchestrator` — function

```ts
function shouldBlockOrchestrator(s: FraudStatus) : boolean
```

### `pickBlockReply` — function

```ts
function pickBlockReply(s: FraudStatus) : string | null
```

### `describeBlockReason` — function

```ts
function describeBlockReason(s: FraudStatus) : string
```

### `CONFIRMED_FRAUD_REPLY` — const

```ts
const CONFIRMED_FRAUD_REPLY
```

### `CHARGEBACK_REPLY` — const

```ts
const CHARGEBACK_REPLY
```

### `FraudStatus` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

- The fraud_cases select must use `last_seen_at` (not nonexistent `updated_at`) for the confirmed timestamp. See [[../tables/fraud_cases]] — `last_seen_at` is the case's real last-touched timestamp, rewritten by [[fraud-detector]] on each re-detection.

## Status / open work

✅ **customer-fraud-status-selects-nonexistent-updated-at** (2026-07-14) — Fixed: `getCustomerFraudStatus` was selecting `fraud_cases.updated_at` (column does not exist), causing the query to error and return null for all customers. Removed nonexistent `updated_at` from the select and use `last_seen_at` for confirmed timestamps, matching the actual fraud_cases schema. The fix corrects a silent security/correctness failure in a risk-gating path where confirmed-fraud and amazon-reseller customers were incorrectly read as clean.

---

[[../README]] · [[../../CLAUDE]]
