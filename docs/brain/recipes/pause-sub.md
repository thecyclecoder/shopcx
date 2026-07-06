# Pause a subscription

## Helper

```ts
import { appstleSubscriptionAction } from "@/lib/appstle";
```

**File:** `src/lib/appstle.ts` (line 31)

## Signature

```ts
async function appstleSubscriptionAction(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
  cancelReason?: string,
  cancelledBy?: string,   // operator display_name, only for cancel
): Promise<{ success: boolean; error?: string }>
```

## Minimal example

```ts
const result = await appstleSubscriptionAction(
  workspaceId,
  subscription.shopify_contract_id,
  "pause"
);

if (!result.success) {
  // Don't tell the customer "paused" — escalate instead.
  console.error("pause failed:", result.error);
}
```

## Auto-resume

If you want the pause to expire at a specific date, set `subscriptions.pause_resume_at` after pausing. [[../inngest/portal-auto-resume]] picks up expired pauses every minute and calls `appstleSubscriptionAction("resume")`.

```ts
await admin
  .from("subscriptions")
  .update({ pause_resume_at: new Date(Date.now() + 30 * 86400000).toISOString() })
  .eq("id", subscription.id);
```

## Gotchas

- **Internal-sub guard** runs first. Internal subs flip `status='paused'` in our DB; no Appstle call.
- **`status='paused'` means not auto-charging.** It's different from `cancelled` (not billing — but reactivatable via `resume`/`status=ACTIVE`, [[../integrations/appstle]] § Cancel is reversible) and `active` (paying).
- **Crisis Tier 3 berry_only pause** doesn't set `pause_resume_at` — it stays paused until crisis resolution, which sets it manually.

## Related

[[../libraries/appstle]] · [[resume-sub]] · [[cancel-sub-via-journey]] · [[../lifecycles/crisis-campaign]] · [[../inngest/portal-auto-resume]]
