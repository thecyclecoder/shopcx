# Bill now (force a subscription charge)

Manually trigger a billing attempt for a subscription, outside its normal `next_billing_date`.

## Helper

```ts
import { appstleAttemptBilling } from "@/lib/appstle";
```

**File:** `src/lib/appstle.ts` (line 300)

## Signature

```ts
async function appstleAttemptBilling(
  workspaceId: string,
  billingAttemptId: string,   // Appstle billing attempt id, NOT contract id
): Promise<{ success: boolean; error?: string }>
```

## Getting the billing attempt id

The billing attempt id comes from Shopify's `billing_attempt_failure` webhook payload or from `appstleGetUpcomingOrders()`:

```ts
import { appstleGetUpcomingOrders, appstleAttemptBilling } from "@/lib/appstle";

const upcoming = await appstleGetUpcomingOrders(workspaceId, contractId);
const nextBillingAttemptId = upcoming?.[0]?.billing_attempt_id;
if (!nextBillingAttemptId) throw new Error("no upcoming order");

await appstleAttemptBilling(workspaceId, nextBillingAttemptId);
```

## When to use this

- **Dunning recovery** — `dunning-new-card-recovery` calls this after switching cards.
- **Customer portal "bill now"** — see [[../libraries/portal__handlers__order-now]].
- **Dashboard agent "bill now"** — `src/app/api/workspaces/[id]/subscriptions/[subId]/bill-now/route.ts` (agent UI button on a subscription); gates on [[../libraries/portal__order-now-guard]] for Appstle subs, returning 409 if the contract is cancelled/inactive.
- **Manual admin retry** — agent UI button on a dunning-stuck sub.

## Gotchas

- **Don't pass the contract id.** It's the billing attempt id (numeric, from the Appstle billing-attempts API).
- **No silent re-attempt loops.** If billing fails, the webhook fires `dunning/payment-failed` and our pipeline takes over. Don't call `appstleAttemptBilling` in a retry loop — it'll fight the dunning engine.
- **Internal subs** use a separate path (`internal-subscription.ts`) that goes straight to [[../integrations/braintree]] `transaction.sale`.
- **Always preceded by a card update** in production usage. Calling this without ensuring the card is fresh just re-fails.

## Related

[[../libraries/appstle]] · [[../lifecycles/dunning]] · [[../inngest/dunning]]
