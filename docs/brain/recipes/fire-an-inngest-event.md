# Fire an Inngest event

The async escape hatch. Anywhere we'd otherwise `await` an expensive side-effect, fire an event and let the Inngest function handle it durably.

## Helper

```ts
import { inngest } from "@/lib/inngest/client";
```

**File:** `src/lib/inngest/client.ts`

## Sending from a request handler / API route

```ts
await inngest.send({
  name: "dunning/payment-failed",
  data: {
    workspace_id: workspaceId,
    subscription_id: subscription.id,
    customer_id: customerId,
    shopify_contract_id: subscription.shopify_contract_id,
    shopify_customer_id: subscription.shopify_customer_id,
    billing_attempt_id: bilingAttemptId,
    error_code: errorCode,
    error_message: errorMessage,
  },
});
```

The event lands in Inngest's queue; matching functions (functions with `triggers: [{ event: "dunning/payment-failed" }]`) pick it up.

## Sending from inside an Inngest function (durable)

```ts
await step.sendEvent("re-trigger", {
  name: "ticket/inbound-message",
  data: { workspace_id, ticket_id, message_body, channel, is_new_ticket: false },
});
```

`step.sendEvent` is **durable** — recorded as a step, won't re-fire on Inngest function retry. `inngest.send` inside an Inngest function is NOT durable; the event will re-fire on retry.

## Event naming convention

`{domain}/{event-name}` with kebab-case. Examples in production:

- `ticket/inbound-message` — every inbound customer message
- `dunning/payment-failed` — billing decline
- `dunning/new-card-recovery` — customer added a card during dunning
- `dunning/billing-success` — successful charge after dunning cycle
- `returns/process-delivery` — EasyPost confirmed delivery
- `returns/issue-refund` — kick off refund
- `crisis/daily-campaign` — daily crisis cron
- `chargebacks/dispute-received` — Shopify dispute webhook
- `social-comments/new` — Meta comment webhook
- `storefront/event.created` — pixel event ingest → CAPI fan-out

See [[../inngest/README]] (the inngest folder index) for the full registry.

## Concurrency control

When the receiving function declares a concurrency key:

```ts
concurrency: [{ limit: 1, key: "event.data.ticket_id" }]
```

…Inngest serializes events with the same key. Useful for ticket handlers (one in-flight per ticket).

## Gotchas

- **Payload is JSON-serializable only.** No `Date` objects (pass ISO strings), no functions, no circular refs.
- **`step.sendEvent` from inside functions.** Don't use bare `inngest.send` inside Inngest functions — it re-fires on retry.
- **Don't await long Promises outside `step.run`** in Inngest functions. Wrap any side effect.
- **Names are exact strings.** Typos silently drop. Triple-check.
- **Don't fan-out from a request handler.** If you have N events to fire, send them all in one batch: `await inngest.send([event1, event2, ...])`.
- **Idempotency**: at-least-once delivery is the rule. Functions must be idempotent.

## Related

[[../integrations/inngest]] · [[../inngest/unified-ticket-handler]] · [[write-a-migration-apply-script]]
