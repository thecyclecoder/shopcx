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

_None documented._

---

[[../README]] · [[../../CLAUDE]]
