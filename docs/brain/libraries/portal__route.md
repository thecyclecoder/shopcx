# libraries/portal/route

The **main portal request handler** that processes customer actions: subscription detail, cancel, change-date, frequency, loyalty redeem, add payment method, order-now, ban request, and support ticket creation.

**File:** `src/app/api/portal/route.ts`

## Overview

Each customer action POST lands here (`POST /api/portal`), gets routed by `action` field to its handler, and returns the result. The route is the **unified error boundary** for all portal mutations — every Appstle error, validation error, and unexpected failure is caught here and returned to the customer's portal UI.

## Key patterns

### Input guard: string coercion before `.startsWith`

Portal actions receive customer input from request body, query params, and URL tokens (e.g. subscription ID, product ID, token). Any value expected to be a string **must be guarded with `typeof x === 'string'`** before calling `.startsWith()` or other string methods. A numeric or undefined value (e.g., Appstle's `id` JSON field as a number, a missing token) will throw `TypeError: x.startsWith is not a function` — 500-ing the request.

**Pattern:**
```ts
// BAD — crashes on non-string
if (token.startsWith("internal-")) { ... }

// GOOD — guards first, returns handled 400 if wrong type
if (typeof token === 'string' && token.startsWith("internal-")) { ... }
// OR coerce
const tokenStr = String(token); if (tokenStr.startsWith(...)) { ... }
```

Every portal handler and route utility that receives input should apply this guard. Signature: `vercel:a08795a29d9404a4` (the prod stack minified `.startsWith` to `t`, traced to a non-string value at the route boundary).

### Validation errors that shouldn't create tickets

The route short-circuits on **predictable validation failures** that the customer already knows about (no ticket):

- `insufficient_points` (loyalty redeem out of budget)
- `would_remove_last_item` / `would_remove_all_regular_products` (subscription constraints)
- Any `error` message matching `/^insufficient points/i` (Appstle text variant)

These flow through `[[portal__remediation]]` if a stale ticket still lands (belt-and-suspenders), but the route gate stops them spawning in the first place. See [[portal__remediation]] for downstream auto-dismiss + replay logic.

## Callers

- Direct: every portal UI action (`POST /api/portal` with `action` field) routes here via `app/api/portal/route.ts`
- Error boundary: [[portal__remediation]] ingests tickets created when this route errors

## Gotchas

- **Type safety vs. runtime reality.** A typed parameter `foo: string` is not safe from a JSON number or undefined input. Always guard with `typeof` before string methods.
- **Transient errors wrap as 502.** Every Appstle error (including 4xx validation errors) is wrapped as HTTP 502 by `handleAppstleError`. The status is useless for classification — [[portal__remediation]] keys off the error **message**, not the status. If you're adding a new error type, emit a stable code (e.g., `body.error = 'would_remove_last_item'`) that remediation can match.

## Related

[[portal__remediation]] · [[portal__helpers]] · [[../integrations/appstle]] · [[../tables/portal]] · [[../recipes/next-js-api-route-patterns]]
