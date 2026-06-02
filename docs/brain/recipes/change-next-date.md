# Change next billing date

Move the next charge to a specific future date.

## Helper

```ts
import { appstleUpdateNextBillingDate } from "@/lib/appstle";
```

**File:** `src/lib/appstle.ts` (line 217)

## Signature

```ts
async function appstleUpdateNextBillingDate(
  workspaceId: string,
  contractId: string,
  nextBillingDate: string,   // YYYY-MM-DD or full ISO datetime
): Promise<{ success: boolean; error?: string }>
```

## Minimal example

```ts
// Push the next charge out by 30 days
const next = new Date(Date.now() + 30 * 86400 * 1000)
  .toISOString().slice(0, 10);   // YYYY-MM-DD

await appstleUpdateNextBillingDate(
  workspaceId,
  subscription.shopify_contract_id,
  next
);
```

## Gotchas

- **Format strict.** Appstle accepts `YYYY-MM-DD` (treated as midnight UTC of that day) OR a full ISO `2026-07-15T16:00:00Z`. Don't pass a JS `Date` object.
- **rescheduleFutureOrder is hardcoded to `true`** in our wrapper — all future orders shift, not just the next one. If you want to skip just one order, use [[bill-now]] or `appstleSkipNextOrder`.
- **Past dates are accepted by Appstle** but won't trigger a backdated charge — they just set the field. If you need an immediate charge, use [[bill-now]].
- **Internal subs** update `subscriptions.next_billing_date` directly in our DB.

## Related

[[../libraries/appstle]] · [[bill-now]] · [[pause-sub]]
