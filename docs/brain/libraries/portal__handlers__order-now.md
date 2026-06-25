# libraries/portal/handlers/order-now

Portal bill now (manual renewal).

**File:** `src/lib/portal/handlers/order-now.ts`

## Exports

### `orderNow` — const

```ts
const orderNow: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

**Concurrent-billing race is treated as success.** Appstle's billing scheduler can fire on the same contract at the same moment a customer clicks "Order now" — Appstle then 400s the manual attempt with "Another billing operation is already in progress." The customer's intent (renew now) is satisfied either way (Appstle's own attempt produces the order), so this handler:

- detects the lock phrase in the [[appstle]] `appstleAttemptBilling` error text,
- returns `jsonOk({ alreadyBilling: true, message: "Your renewal is already being processed." })` instead of a 502,
- logs a `portal.order_now` customer event with `properties.collision = true` so analytics still count the click.

Skipping the 502 path is what stops `src/app/api/portal/route.ts` from spawning a `portal-action-failed` ticket and keeps the Vercel error drain / Control Tower (signature `vercel:7b36a7f314c061ed`) from re-firing on a healthy, self-completing race.

---

[[../README]] · [[../../CLAUDE]]
