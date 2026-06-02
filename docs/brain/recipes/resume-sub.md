# Resume a paused subscription

## Helper

```ts
import { appstleSubscriptionAction } from "@/lib/appstle";
```

**File:** `src/lib/appstle.ts` (line 31)

## Minimal example

```ts
const result = await appstleSubscriptionAction(
  workspaceId,
  subscription.shopify_contract_id,
  "resume"
);
if (!result.success) throw new Error(result.error || "resume failed");

// Clear any pending auto-resume timer
await admin
  .from("subscriptions")
  .update({ pause_resume_at: null })
  .eq("id", subscription.id);
```

## Gotchas

- **Don't auto-resume a customer-paused sub.** If the customer paused it themselves (not dunning, not crisis, not a remedy), resuming silently is bad UX. Check `customer_events` for the pause source before resuming.
- **Resume sets `next_billing_date` to `now() + billing_interval`** on Appstle's side — they advance the next charge. Don't overwrite this field manually after resuming.
- **Internal subs** flip `status='active'` in our DB; no Appstle call.

## Related

[[../libraries/appstle]] · [[pause-sub]] · [[bill-now]] · [[../inngest/portal-auto-resume]]
