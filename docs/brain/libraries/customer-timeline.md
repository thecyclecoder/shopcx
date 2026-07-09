# libraries/customer-timeline

Build a chronological customer event timeline for AI prompts + agent UI.

**File:** `src/lib/customer-timeline.ts`

## File header

```
Customer timeline + anomaly detectors.
Reads a customer's recent activity (orders, subscriptions, returns,
portal actions, Appstle webhooks) and merges into a chronological,
human-readable timeline. Then runs anomaly detectors that surface
contradictions between customer narrative and ground truth — the
things the AI orchestrator (and human agents) need to notice but
usually don't when staring at flat JSON.
Two consumers:
1. Sonnet orchestrator (`get_customer_timeline` data tool)
2. Ticket detail page Timeline tab (agent UI)
Source of truth is `customer_events` going forward (now richly enriched
— see `feedback_anomaly_framing_neutral` for framing rules), with
cross-reference reconstruction for legacy events.
```

## Exports

### `buildCustomerTimeline` — function

```ts
async function buildCustomerTimeline(workspaceId: string, customerId: string, options: { windowDays?: number } = {},) : Promise<CustomerTimeline>
```

### `timelineToText` — function

```ts
function timelineToText(t: CustomerTimeline) : string
```

### `TimelineEntry` — interface

### `Anomaly` — interface

### `CustomerTimeline` — interface

### `TimelineEntryType` — type

### `AnomalySeverity` — type

## Server-side aggregation (RPC)

The customer link-group expansion (`resolveLinkedCustomerIds`) was refactored to call the server-side `public.resolve_customer_link_group` RPC (Phase 5 of [[../libraries/detail-view-rpcs]]), replacing the prior two-hop JS scan. This collapses the customer-detail round-trip fan-out and converges every link-group expansion onto one SQL primitive.

## Callers

- `src/app/api/tickets/[id]/timeline/route.ts`
- `src/lib/sonnet-orchestrator-v2.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
