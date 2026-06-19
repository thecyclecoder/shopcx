---
name: fire-inngest-event
description: Use to send an Inngest event from ShopCX code or a one-off script — the async escape hatch for durable side-effects (dunning, returns, ticket handling, CAPI fan-out). Exact event names, JSON-only payloads, batched, idempotent. Triggered by "fire/replay the {domain}/{event} event", "re-trigger the dunning/returns flow for {X}", or wiring a new async side-effect.
---

# fire-inngest-event

The async escape hatch. Anywhere you'd `await` an expensive side-effect, fire an event instead and let a durable Inngest function handle it. Same pattern whether you're wiring it into a route or replaying an event from a one-off script.

## Helper

```ts
import { inngest } from "@/lib/inngest/client";   // src/lib/inngest/client.ts
```

## Procedure

1. **Get the exact event name.** `{domain}/{event-name}`, kebab-case (`dunning/payment-failed`, `returns/issue-refund`, `ticket/inbound-message`, `storefront/event.created`). Names are **exact strings** — a typo silently drops, nothing errors. Confirm against [[../../../docs/brain/inngest/README|the inngest registry]] / the receiving function's `triggers: [{ event: "…" }]`; don't guess.
2. **Build a JSON-serializable payload.** Plain data only — **no `Date` objects** (pass ISO strings), no functions, no circular refs. Include the `workspace_id` + the business UUIDs the handler needs (internal joins use UUIDs, never `shopify_*_id`).
3. **Send from a request handler / script:**
   ```ts
   await inngest.send({ name: "dunning/payment-failed", data: { workspace_id, subscription_id, customer_id, error_code } });
   ```
   The event queues; every function whose trigger matches picks it up.
4. **Batch a fan-out — never loop `send`.** N events go in one call: `await inngest.send([event1, event2, …])`. Looping individual sends from a handler is the anti-pattern.
5. **Inside an Inngest function, use `step.sendEvent` (durable).** `await step.sendEvent("label", { name, data })` is recorded as a step so it won't re-fire on retry. Bare `inngest.send` inside a function is **not** durable — it re-fires every retry. Outside functions (routes/scripts) bare `inngest.send` is correct.
6. **Replaying from a script:** standard [[script-conventions]] bootstrap, build the exact payload, `inngest.send` it, and confirm the receiving function ran (its table writes landed). Gate destructive replays behind `--apply`.

## Guardrails

- **At-least-once delivery — handlers must be idempotent.** An event can be delivered more than once; the function must no-op on a repeat. When *you* fire it, assume it may run twice.
- **Names are exact; typos drop silently.** Triple-check the string against the registry — there is no "unknown event" error.
- **Concurrency keys serialize.** If the receiver declares `concurrency: [{ key: "event.data.ticket_id" }]`, same-key events run one-at-a-time — relevant when you batch-fire for many entities.
- **Don't push during active Inngest runs.** A Vercel deploy reaps in-flight functions ([[deploy]]) — don't fire a flood of events and then push.
- **No prod creds under the box worker.** A script that `inngest.send`s to prod triggers real side-effects → request approval (`{"type":"run_prod_script","cmd":"npx tsx scripts/{name}.ts --apply"}`) and stop. Locally/interactively run directly.

## Related
`docs/brain/recipes/fire-an-inngest-event.md` · `src/lib/inngest/client.ts` · skills: `run-orchestrator-action`, `script-conventions` · `docs/brain/integrations/inngest.md` · `docs/brain/inngest/README.md`
