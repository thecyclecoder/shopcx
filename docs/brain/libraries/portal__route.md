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
- Remove-payment-method guard codes: `pinned_to_active_subscription`, `last_card_for_active_subscription`, `not_removable_here`, `payment_method_not_found`, `payment_method_not_in_group`, `missing_paymentMethodId`. Cards are customer-only by PCI design (no agent removal action), and `PaymentMethodsSection.tsx` renders plain-language customer guidance for each of these codes (switch that sub's card, add a replacement first, remove via the Shopify account, etc.). A guarded refusal is UI-gating validation, not a support event — real case: ticket `c969f235` (G Esposito) escalated to a human three times because a legitimate `pinned_to_active_subscription` refusal was double-handled here. See [[portal__handlers__remove-payment-method]].

These flow through `[[portal__remediation]]` if a stale ticket still lands (belt-and-suspenders), but the route gate stops them spawning in the first place. See [[portal__remediation]] for downstream auto-dismiss + replay logic.

## Callers

- Direct: every portal UI action (`POST /api/portal` with `action` field) routes here via `app/api/portal/route.ts`
- Error boundary: [[portal__remediation]] ingests tickets created when this route errors

## Gotchas

- **Type safety vs. runtime reality.** A typed parameter `foo: string` is not safe from a JSON number or undefined input. Always guard with `typeof` before string methods.
- **Transient errors wrap as 502.** Every Appstle error (including 4xx validation errors) is wrapped as HTTP 502 by `handleAppstleError`. The status is useless for classification — [[portal__remediation]] keys off the error **message**, not the status. If you're adding a new error type, emit a stable code (e.g., `body.error = 'would_remove_last_item'`) that remediation can match.

## Related

[[portal__remediation]] · [[portal__helpers]] · [[../integrations/appstle]] · [[../tables/portal]] · [[../recipes/next-js-api-route-patterns]]
