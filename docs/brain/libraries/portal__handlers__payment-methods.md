# libraries/portal/handlers/payment-methods

Portal list payment methods.

**File:** `src/lib/portal/handlers/payment-methods.ts`

## File header

```
Portal route: list the customer's saved payment methods. Read-only
for v1 — adding a new card vault requires the Braintree client-side
Hosted Fields integration which lands as a follow-up. The shape of
this endpoint is forward-compatible with the eventual mutations.
Returns ALL active payment methods on the customer + any linked
customer profiles. A linked account's saved cards are usable by the
shared person; the dunning pipeline already treats them as one
eligible pool, so the portal mirrors that.
Output shape:
{
ok: true,
methods: [{ id, brand, last4, expiration_month, expiration_year,
payment_type, is_default, provider, status }],
migrationEnabled: boolean,  // workspace flag — when true the UI
// shows the "add new card" CTA; when
// false the section is read-only.
}
```

## Exports

### `paymentMethods` — const

```ts
const paymentMethods: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
