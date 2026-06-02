# Cancel a subscription via the cancel journey

Never call `appstleSubscriptionAction(..., "cancel")` directly when the customer asks to cancel. Always route through the cancel journey so the customer sees retention remedies first. This is a hard rule in [[../tables/sonnet_prompts]].

## Helper

```ts
import { launchJourneyForTicket } from "@/lib/journey-launcher";
```

**File:** `src/lib/journey-launcher.ts`

## Minimal example

```ts
await launchJourneyForTicket({
  ticketId,
  workspaceId,
  customerId,
  journeyIntent: "cancel_subscription",
  subscriptionId,   // optional — pin a specific sub
});
```

This creates a [[../tables/journey_sessions]] row, sends the CTA via the ticket's channel, and the customer-facing mini-site takes over from there.

## When to bypass the journey

The only legitimate skip-the-journey case is **confirmed fraud + chargeback** — see [[chargeback-pipeline]] and [[fraud-detection]]. Those paths cancel via `appstleSubscriptionAction(..., "cancel", "fraud", ...)` directly because the customer doesn't get to negotiate.

## Gotchas

- **Never cancel + apologize**. The cancel-flow tells the customer the cancellation happened — you don't need to send a confirmation email separately.
- **Multi-sub customers** — the journey will ask which sub if you don't pin a `subscription_id`. Usually safe to omit.
- **Social comments channel** is **never** allowed for cancel journeys. Hard rule. Route to DM if the customer asks to cancel via a public comment.
- **The journey writes [[../tables/remedy_outcomes]]** for every remedy shown — pass / accept / decline — so the AI selector learns.

## Related

[[../libraries/journey-launcher]] · [[../lifecycles/cancel-flow]] · [[../journeys/cancel]] · [[pause-sub]]
