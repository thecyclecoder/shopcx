# chargeback_events

Shopify disputes — reason, status, amount, customer. Drives auto-cancel pipeline and chargebacks dashboard.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `shopify_dispute_id` | `text` | — |  |
| `shopify_order_id` | `text` | ✓ |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `dispute_type` | `text` | — |  |
| `reason` | `text` | ✓ |  |
| `network_reason_code` | `text` | ✓ |  |
| `amount_cents` | `int4` | ✓ |  |
| `currency` | `text` | ✓ | default: `'USD'` |
| `status` | `text` | — | default: `'under_review'` |
| `evidence_due_by` | `timestamptz` | ✓ |  |
| `evidence_sent_on` | `timestamptz` | ✓ |  |
| `finalized_on` | `timestamptz` | ✓ |  |
| `auto_action_taken` | `text` | ✓ |  |
| `auto_action_at` | `timestamptz` | ✓ |  |
| `fraud_case_id` | `uuid` | ✓ | → [[fraud_cases]].id |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `raw_payload` | `jsonb` | — | default: `'{}'` |
| `initiated_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `fraud_case_id` → [[fraud_cases]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[chargeback_subscription_actions]].`chargeback_event_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("chargeback_events")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("chargeback_events")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("chargeback_events")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Shopify boundary lookup (webhook ingest only — never for internal joins)
```ts
const { data } = await admin.from("chargeback_events")
  .select("*").eq("shopify_order_id", shopifyId).maybeSingle();
```

### Rows for a ticket
```ts
const { data } = await admin.from("chargeback_events")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("chargeback_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- From Shopify dispute polling + webhook. `reason` drives auto-action routing.
- `status`: `under_review` / `won` / `lost` (**lowercase**).
- `reason` values seen in practice: `fraudulent`, `product_not_received`, `credit_not_processed`, `product_unacceptable`. `fraudulent` is the only one that triggers `auto_action_taken='subscriptions_cancelled'` — the rest get `flagged_for_review` and require an agent to act.
- `auto_action_taken`: `subscriptions_cancelled` / `flagged_for_review` / `none`.
- Sub-cancellations live in [[chargeback_subscription_actions]] keyed by `chargeback_event_id` — for the actual subscriptions cancelled, join that table. `auto_action_taken='subscriptions_cancelled'` tells you the action FIRED; the child rows tell you WHICH subs.
- `initiated_at` is the dispute initiation date from Shopify, `created_at` is when WE first saw it via polling/webhook — use `initiated_at` when ordering for "newest disputes."

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
