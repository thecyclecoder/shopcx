# cx-agent-sdk — Deterministic read-only CX data for box agents

**Phase 1 of [[../specs/cx-box-agents-sol-cora-june-deterministic-sdk-toolset-and-brain-access-no-raw-sql]]** (shipped 2026-07).

## Overview

Read-only typed SDK for the three CX box agents ([[../functions/ticket-handler|Sol]], [[../functions/ticket-analyzer|Cora]], [[../functions/cs|June]]) to fetch customer + workspace data deterministically. Replaces ad-hoc SQL queries that missed columns or returned empty results.

- **Read-only** — the worker ([[../libraries/builder-worker]]) remains the sole mutator.
- **Deterministic** — same typed interface, same data shape for all three agents.
- **Merged-identity fan-out** — all queries automatically span linked customer accounts (same human, separate rows).
- **CLI access** — `npx tsx scripts/cx-agent-sdk-tool.ts <verb> <ticket_id>` from box sessions.

## Exports

### Data getters

```typescript
getCxCustomer(admin, workspaceId, customerId) → Promise<CxCustomer>
```
Primary customer profile + all linked customer_ids in the same group (via [[../libraries/customer-links|linkGroupIds]]). Returns profile row fields: `first_name`, `last_name`, `email`, `subscription_status`, `retention_score`, `email_marketing_status`, `sms_marketing_status`, `shopify_customer_id`.

```typescript
getCxOrders(admin, workspaceId, customerId) → Promise<CxOrder[]>
```
Recent orders (last 180 days, capped 25) across the linked-identity group. Each line item includes:
- `quantity`, `variant_title`, `sku`
- `per_unit_cents` — actual charged amount ÷ qty (matches `computeChargedLineTotals` in [[../libraries/sonnet-orchestrator-v2|sonnet-orchestrator-v2]])
- `line_total_cents` — line total the customer was charged
- `subscription_id` — null for one-time orders

```typescript
getCxSubscriptions(admin, workspaceId, customerId) → Promise<CxSubscription[]>
```
All subscriptions across the linked-identity group. Each subscription includes:
- `status`, `billing_interval`, `billing_interval_count`, `next_billing_date`
- `items` with `price_cents` (Shopify contracts) + `price_override_cents` (internal contracts) + `realized_cents` (whichever is set)
- `applied_discounts` — coupons/applied discounts (same JSONB structure internal + Shopify contracts both persist)

```typescript
getCxProducts(admin, workspaceId) → Promise<CxProduct[]>
```
Workspace's active product catalog (status='active'). Each product includes variants with `title` + `price_cents` so agents can cite real flavor names (Berry vs Peach) and verify per-unit pricing claims.

```typescript
getCxPolicies(admin, workspaceId) → Promise<CxPolicy[]>
```
Workspace's active `sonnet_prompts` rules (enabled=true, status='approved') — the same rules the deployed orchestrator reads via `loadLiveRules` in [[../libraries/agent-todos|agent-todos/triage]]. Agents consult these to resolve return/refund/subscription-billing policies.

```typescript
getCxBundle(admin, workspaceId, customerId | null) → Promise<CxBundle>
```
One-shot `Promise.all` of all five getters. Returns typed data (see below); the plain-text rendering is `formatCxBundle`.

```typescript
listActionableOutcomes(admin, workspaceId, intent, opts?: { channel?: string | null }) → Promise<CxActionableOutcomes>
```
Phase 1 of [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]] — deterministic catalog reader Sol's first-touch box session consults before authoring the Direction. Returns the workspace's **ACTIVE** [[../tables/journey_definitions|journeys]] (matched by `trigger_intent`), [[../tables/playbooks|playbooks]] (matched by `trigger_intents[]`), and [[../tables/workflows|workflows]] (matched by `trigger_tag`) for the resolved `intent`. Optional `opts.channel` narrows journeys + workflows to those whose `channels[]` includes the ticket's channel (an empty `channels[]` on the mechanism means broad-match — always passes).
- Case-insensitive on all trigger fields.
- Workspace-scoped on every axis (learning #6 — the confirming predicate at the action point).
- Empty catalog is a valid, non-error result: Sol treats it as "no active mechanism → `chosen_path='stateless'`". A non-empty catalog is her signal to name a `journey_slug` / `playbook_slug` on the Direction so Phase 2 can APPLY the mechanism (`launchJourneyForTicket` / `startPlaybook`) rather than compose a freeform "click below" reply.
- Rendered by `formatActionableOutcomes` (one-block plain text; the empty case surfaces the `stateless` fallback line explicitly).

### Formatters

```typescript
formatCxBundle(bundle: CxBundle) → string
```
Plain-text snapshot embedded at the top of the prepared briefs ([[../libraries/builder-worker|builder-worker]] § `loadCxAgentSdkBrief`, `loadTicketHandleBrief`, `loadCsDirectorCallBrief`). Agents see:
```
--- CX SDK snapshot (deterministic read-only; call the SDK, not raw SQL) ---
CUSTOMER: <name> <email> · linked: <ids> · sub: <status> · retention: <score>
SUBSCRIPTIONS: (list)
ORDERS: (last 180 days)
PRODUCTS: (active catalog)
POLICIES: (active sonnet_prompts)
```

### CLI

```typescript
runCxSdkVerb(admin, verb: CxSdkVerb, workspaceId, customerId | null) → Promise<string>
```
Dispatch a verb (`"customer"` | `"orders"` | `"subscriptions"` | `"products"` | `"policies"` | `"bundle"`) to its formatted text output. Wrapped by `scripts/cx-agent-sdk-tool.ts` CLI:
```bash
npx tsx scripts/cx-agent-sdk-tool.ts customer <ticket_id>
npx tsx scripts/cx-agent-sdk-tool.ts bundle <ticket_id>
npx tsx scripts/cx-agent-sdk-tool.ts products <ticket_id>
```

## Integration

**Worker briefs** — all three prepared briefs wire the SDK snapshot:
- `loadTicketHandleBrief` ([[../libraries/builder-worker]] § `loadCxAgentSdkBrief`) — Sol's brief includes the full bundle snapshot
- `loadCsDirectorCallBrief` — June's brief includes the full bundle snapshot
- `runTicketAnalyzeJob` — fetches the snapshot and threads it to Cora via `ticketAnalyzePrompt`

**Agent prompts** direct all three:
- First, call `npx tsx scripts/cx-agent-sdk-tool.ts <verb> <ticket_id>` for these CX surfaces (customer, orders, subscriptions, products, policies)
- Never author raw SQL for customer/order/subscription/product/policy lookups

**Box sessions** — each agent has read access to `scripts/cx-agent-sdk-tool.ts` CLI; the prepared bundle already embeds the snapshot so agents START with the right shape (zero SQL needed).

## Data shapes

```typescript
interface CxCustomer {
  customer_id: string;
  linked_customer_ids: string[];  // all in the same group
  profile: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    subscription_status: string | null;
    retention_score: number | null;
    email_marketing_status: string | null;
    sms_marketing_status: string | null;
    shopify_customer_id: string | null;
  } | null;
}

interface CxOrderLine {
  title: string;
  variant_id: string | null;
  variant_title: string | null;
  quantity: number;
  per_unit_cents: number;
  line_total_cents: number;
  sku: string | null;
}

interface CxOrder {
  order_number: string | null;
  shopify_order_id: string | null;
  total_cents: number;
  financial_status: string | null;
  created_at: string;
  source_name: string | null;
  subscription_id: string | null;
  line_items: CxOrderLine[];
}

interface CxSubscriptionItem {
  title: string;
  variant_id: string | null;
  variant_title: string | null;
  quantity: number;
  price_cents: number | null;
  price_override_cents: number | null;
  realized_cents: number;  // price_cents ?? price_override_cents ?? 0
}

interface CxSubscriptionDiscount {
  id: string | null;
  title: string | null;
  type: string | null;
  value: number | null;
  value_type: string | null;
}

interface CxSubscription {
  id: string;
  customer_id: string;
  shopify_contract_id: string | null;
  status: string;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  created_at: string;
  items: CxSubscriptionItem[];
  applied_discounts: CxSubscriptionDiscount[];
}

interface CxProduct {
  id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  variants: CxProductVariant[];
}

interface CxProductVariant {
  id: string;
  title: string | null;
  price_cents: number | null;
}

interface CxPolicy {
  category: string;
  title: string;
  content: string;
}

interface CxBundle {
  workspace_id: string;
  customer_id: string | null;
  customer: CxCustomer | null;
  orders: CxOrder[];
  subscriptions: CxSubscription[];
  products: CxProduct[];
  policies: CxPolicy[];
}

interface CxActionableJourney {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  trigger_intent: string;
  channels: string[];
  priority: number;
}

interface CxActionablePlaybook {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  trigger_intents: string[];
  priority: number;
}

interface CxActionableWorkflow {
  id: string;
  name: string;
  template: string;
  trigger_tag: string;
  channels: string[];
}

interface CxActionableOutcomes {
  workspace_id: string;
  intent: string;
  channel: string | null;
  journeys: CxActionableJourney[];
  playbooks: CxActionablePlaybook[];
  workflows: CxActionableWorkflow[];
}
```

## Implementation notes

**Merged-identity fan-out** — all getters call [[../libraries/customer-links|linkGroupIds]] to expand the passed `customer_id` to the full group, then `.in(linked_ids)` every query. Same expansion rule as `sonnet-orchestrator-v2`'s `resolveLinkedCustomerIds` so claims on sibling profiles (Roxana's linked account) are visible to the agent.

**Per-unit pricing** — `getCxOrders` computes `per_unit_cents = lineTotal ÷ qty`, matching the surface `computeChargedLineTotals` in the deployed orchestrator. Agents see the ACTUAL charged per-unit, not the pre-discount Shopify unit price.

**Subscription pricing** — `getCxSubscriptions` exposes both `price_cents` (Shopify contracts) and `price_override_cents` (internal contracts), with `realized_cents` resolving to whichever is set. Agents can cite the real configured price.

**Product catalog** — `getCxProducts` reads only `status='active'` rows so agents cite current flavors/variants.

**Policies** — `getCxPolicies` reads only enabled, approved `sonnet_prompts` rows — the SAME source the deployed orchestrator consults. Agents consult these for return/refund/billing policy rules.

**CLI dispatch** — `runCxSdkVerb` is a thin dispatch layer; `scripts/cx-agent-sdk-tool.ts` wraps it for box sessions.

## Status / open work

Phase 1 (deterministic read-only CX SDK) is shipped and in production. Phases 2 (deterministic playbook resolution) and 3 (brain access for Sol/Cora/June) remain in planned.

`listActionableOutcomes` (Phase 1 of [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]]) added — deterministic outcome→mechanism catalog reader. Phases 2–4 (apply the matched mechanism, claim-guard on referenced-CTA-without-launch, end-to-end tests) remain planned.

## Callers

- [[../libraries/builder-worker]] § `loadCxAgentSdkBrief`, `loadTicketHandleBrief`, `loadCsDirectorCallBrief`
- [[../inngest/ticket-handler]] — Sol's brief
- [[../inngest/ticket-analyzer]] — Cora's context
- [[../inngest/cs-director-call]] — June's context
