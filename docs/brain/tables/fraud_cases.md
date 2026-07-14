# fraud_cases

Active fraud investigations. rule_type, severity, orders_held, resolution.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `rule_id` | `uuid` | ✓ | → [[fraud_rules]].id |
| `rule_type` | `text` | — |  |
| `status` | `text` | — | default: `'open'` |
| `severity` | `text` | — | default: `'medium'` |
| `title` | `text` | — |  |
| `summary` | `text` | ✓ |  |
| `evidence` | `jsonb` | — | default: `'{}'` |
| `customer_ids` | `uuid[]` | ✓ | default: `'{}'` |
| `order_ids` | `text[]` | ✓ | default: `'{}'` · Holds internal [[orders]].`id` UUIDs, NEVER `shopify_order_id` (Shopify is being sunset — CLAUDE.md "internal joins use UUIDs"). Every writer in [[../libraries/fraud-detector]] stores `order.id`; readers that hit `orders` via `.in('id', order_ids)` go through the exported `orderUuids()` filter so a stray legacy Shopify id can't crash the `uuid` column with Postgres 22P02 and silently drop the whole batch of fraud orders. |
| `assigned_to` | `uuid` | ✓ | → [[workspace_members]].id |
| `reviewed_by` | `uuid` | ✓ | → [[workspace_members]].id |
| `reviewed_at` | `timestamptz` | ✓ |  |
| `review_notes` | `text` | ✓ |  |
| `resolution` | `text` | ✓ |  |
| `dismissal_reason` | `text` | ✓ |  |
| `first_detected_at` | `timestamptz` | — | default: `now()` |
| `last_seen_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `orders_held` | `bool` | ✓ | default: `false` |
| `ai_analysis` | `jsonb` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `assigned_to` → [[workspace_members]].`id`
- `reviewed_by` → [[workspace_members]].`id`
- `rule_id` → [[fraud_rules]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[chargeback_events]].`fraud_case_id`
- [[fraud_action_log]].`fraud_case_id`
- [[fraud_case_history]].`case_id`
- [[fraud_rule_matches]].`case_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("fraud_cases")
  .select("id, status, title, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("fraud_cases")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("fraud_cases")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- `rule_type` matches `fraud_rules.slug`.
- `status`: schema supports `open`, `reviewing`, `confirmed_fraud`, `dismissed`. Production data only has `dismissed` and `confirmed_fraud` — the open/reviewing states exist for the UI workflow but resolve fast (no long-lived `open` cases in prod).
- Orchestrator bails (closes + escalates with confirmed-fraud reply) if customer has ANY `status='confirmed_fraud'` OR `rule_type='amazon_reseller'`. See feedback_orchestrator_fraud_gate.
- Chargebacks don't create fraud cases anymore — only actual rules do.
- `order_ids` holds INTERNAL `orders.id` UUIDs. Historically mixed with `shopify_order_id` numeric strings, which crashed the two `.in('id', order_ids)` readers (confirmed-fraud similarity batch + high-velocity load) with Postgres 22P02 and silently dropped every fraud order in the batch. Every writer now stores `order.id`; readers wrap `order_ids` with `orderUuids()` in [[../libraries/fraud-detector]] as defense-in-depth.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
