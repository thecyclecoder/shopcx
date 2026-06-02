# libraries/integrations/amplifier

Amplifier (3PL) webhook handler — `order_received` / `order_shipped` events.

**File:** `src/lib/integrations/amplifier.ts`

## File header

```
Amplifier 3PL — order creation helper.
Reference: amplifier-api.md (POST /orders).
- Base URL:    https://api.amplifier.com
- Auth:        HTTP Basic with the workspace's amplifier API key as
username, blank password. We use the auth_token query
param form to keep header surface small.
- Order body:  order_source_code (workspace-configured), order_id (our
order_number), order_date, billing_info, shipping_info,
shipping_method, line_items.
Address policy from the user spec: Amplifier requires BOTH billing
and shipping. If we only have one we mirror to the other.
Return shape: `{ id }` on success — that's the Amplifier order
UUID, which we store on `orders.amplifier_order_id` so the
existing order.received webhook flow stays consistent.
```

## Exports

### `createAmplifierOrder` — function

```ts
async function createAmplifierOrder(input: CreateAmplifierOrderInput) : Promise<CreateAmplifierOrderResult>
```

### `CreateAmplifierOrderInput` — interface

### `CreateAmplifierOrderResult` — interface

## Callers

- `src/app/api/checkout/route.ts`
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts`
- `src/lib/inngest/internal-subscription-renewals.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
