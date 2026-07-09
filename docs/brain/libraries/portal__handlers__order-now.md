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

## Appstle status guard (ticket 183d28b9)

The Appstle branch gates every `appstleAttemptBilling` call through [[portal__order-now-guard]] before firing it. Cancelled or non-active Appstle contracts that have been migrated to internal subs surface misleading vendor errors (false "out of stock" on a stale contract), so the guard blocks upfront and returns a clean 409 `contract_cancelled` / `contract_not_active` instead of proxying the confusing raw Appstle body.

The internal branch already gated on `status !== "active"` — the guard mirrors that predicate to the Appstle branch so both paths have the same behavior: active subs proceed, everything else is blocked with a friendly message. See [[portal__order-now-guard]].

## Gotchas

**Concurrent-billing race is treated as success.** Appstle's billing scheduler can fire on the same contract at the same moment a customer clicks "Order now" — Appstle then 400s the manual attempt with "Another billing operation is already in progress." The customer's intent (renew now) is satisfied either way (Appstle's own attempt produces the order), so this handler:

- detects the lock phrase in the [[appstle]] `appstleAttemptBilling` error text,
- returns `jsonOk({ alreadyBilling: true, message: "Your renewal is already being processed." })` instead of a 502,
- logs a `portal.order_now` customer event with `properties.collision = true` so analytics still count the click.

Skipping the 502 path is what stops `src/app/api/portal/route.ts` from spawning a `portal-action-failed` ticket and keeps the Vercel error drain / Control Tower (signature `vercel:7b36a7f314c061ed`) from re-firing on a healthy, self-completing race.

---

[[../README]] · [[../../CLAUDE]]
