# libraries/customer-events

`logCustomerEvent()` — writes [[../tables/customer_events]]. Source of truth for the activity timeline (sub cancel/pause timestamps live here, not on the sub row).

**File:** `src/lib/customer-events.ts`

## Exports

### `logCustomerEvent` — function

```ts
async function logCustomerEvent({ workspaceId, customerId, eventType, source, summary, properties, }: { workspaceId: string; customerId: string | null; eventType: string; source: string; summary?: string; properties?: Record<string, unknown>; })
```

## Callers

- `src/app/api/portal/route.ts`
- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`
- `src/app/api/webhooks/email/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/bill-now/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/coupon/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/items/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/payment-update/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts`
- `src/lib/portal/helpers.ts`
- `src/lib/shopify-webhooks.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
