# inngest

Inngest — durable workflow engine. Every background job, cron, webhook fan-out, and multi-step pipeline runs as an Inngest function. Includes step-level retries, concurrency control, durable sleeps, and event-driven branching.

## Auth

**Env only:**
- `INNGEST_EVENT_KEY` — key used by our app to `inngest.send()` events
- `INNGEST_SIGNING_KEY` — Inngest signs deliveries back to our webhook endpoint with this

No per-workspace config. Inngest is account-scoped to the Vercel project.

## SDK

Client: `src/lib/inngest/client.ts` exports a singleton `inngest` (`@inngest/sdk` npm package).

Functions register at `/api/inngest` — Inngest discovers them via the SDK's served handler at runtime.

## Triggers

| Type | How |
|---|---|
| **Event** | `triggers: [{ event: "some/event-name" }]` — fired via `inngest.send({ name, data })` |
| **Cron** | `triggers: [{ cron: "0 * * * *" }]` — UTC unless you pass a tz prefix like `TZ=America/Chicago 0 10 * * *` |
| **Multi-event** | array — function fires on any matching event |

## Sending events

```ts
import { inngest } from "@/lib/inngest/client";
await inngest.send({ name: "dunning/payment-failed", data: { workspace_id, ... }});
```

For inside a step (durable):
```ts
await step.sendEvent("re-trigger", { name: "ticket/inbound-message", data: {...} });
```

The named string can be anything; convention is `domain/event-name` (e.g. `returns/issue-refund`).

## Steps + durability

```ts
const result = await step.run("step-name", async () => { ... });
await step.sleep("wait-2h", "2h");
await step.sleepUntil("wait-until", new Date(...));
const event = await step.waitForEvent("await-customer-reply", { event: "ticket/customer-reply", timeout: "24h", match: "data.ticket_id" });
```

Each `step.run()` block is memoized — if the function retries, completed steps are skipped. **Side effects inside `step.run()` are crash-safe**; side effects outside `step.run()` will re-execute on retry.

## Concurrency

```ts
concurrency: [{ limit: 3, key: "event.data.workspace_id" }]
```

Per-key throttle — at most 3 of this function running concurrently per workspace. Prevents Shopify/Klaviyo rate-limit storms.

## Retries

```ts
{ retries: 2 }
```

Default is 3. Set to 0 for "fire once, don't retry on failure" (rare). Failed runs surface in Inngest dashboard + can be replayed manually.

## Gotchas

- **Deploys are safe — functions are step-durable.** A deploy mid-run retries the current step and resumes, so push freely (the old "don't push during a sync" rule was retired 2026-06-22 — it was about monolithic Shopify syncs, now sunset).
- **`step.run` requires a *stable* step name** — if you name it dynamically with a timestamp, the memoization breaks on retry.
- **Don't `await` Promises outside `step.run`** — they're not durable. Wrap any side effect (DB write, API call, email send) in a step.
- **Concurrency key must be on `event.data.X`** — Inngest cannot dereference into nested fields in some SDK versions.
- **Cron timezones**: Inngest crons default to UTC. Past pattern: `TZ=America/Chicago 0 10 * * *` for 10 AM Central. Many of our crons run at `0 10 * * *` for 4 AM Central — that's 10 UTC, not 10 Central. Double check.
- **`step.sendEvent` vs `inngest.send`** — both work mid-function. `step.sendEvent` is durable (recorded as a step); plain `inngest.send` is not (will re-fire on retry). Use `step.sendEvent` inside Inngest functions.
- **Event payloads are JSON-serializable only.** No Date objects, no functions, no circular refs.
- **No long-running stateful sockets.** All work must fit in the step model.
- **Dev signing key vs prod signing key** — flipping environments without rotating the key breaks delivery verification.

## Files

- `src/lib/inngest/client.ts` — SDK client init
- `src/lib/inngest/*.ts` — 50 function files; see [[../README]] § Inngest functions
- `src/app/api/inngest/route.ts` — Webhook handler that Inngest calls back into

## Related

[[../README]] · all [[../inngest/*]] pages
