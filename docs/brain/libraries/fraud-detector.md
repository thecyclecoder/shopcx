# libraries/fraud-detector

Rule evaluator + case creator. Iterates active [[../tables/fraud_rules]] for the workspace, runs the matcher per rule, creates [[../tables/fraud_cases]] on match.

**File:** `src/lib/fraud-detector.ts`

## Exports

### `runAllFraudRules` — function

```ts
async function runAllFraudRules(workspaceId: string) : Promise<FraudDetectionResult[]>
```

### `checkOrderForFraud` — function

```ts
async function checkOrderForFraud(workspaceId: string, orderId: string, customerId: string | null) : Promise<void>
```

### `checkCustomerForFraud` — function

```ts
async function checkCustomerForFraud(workspaceId: string, customerId: string) : Promise<void>
```

## Callers

- `src/app/api/checkout/route.ts`
- `src/lib/inngest/fraud-detection.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
