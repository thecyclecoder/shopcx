# libraries/portal/handlers/reactivate

Portal reactivate cancelled sub.

**File:** `src/lib/portal/handlers/reactivate.ts`

## Exports

### `reactivate` — const

```ts
const reactivate: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

- The restart itself lives in [[subscription-reactivate]] `reactivateSubscription`, shared with the
  win-back journey's single-step route so both surfaces restart a subscription the same way
  (2026-11-21). This handler only resolves the sub, passes the customer's chosen date, maps
  `needs_payment_method` / `needs_address` to 409, and logs the portal event.

---

[[../README]] · [[../../CLAUDE]]
