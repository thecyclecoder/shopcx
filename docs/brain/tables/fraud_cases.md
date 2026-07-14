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
| `order_ids` | `text[]` | ✓ | default: `'{}'` |
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

- No `updated_at` column — the case's touch timestamp is `last_seen_at`, which `fraud-detector` rewrites on every re-detection. Callers that want a "when was this last modified?" value should read `last_seen_at`.
- `rule_type` matches `fraud_rules.slug`.
- `status`: schema supports `open`, `reviewing`, `confirmed_fraud`, `dismissed`. Production data only has `dismissed` and `confirmed_fraud` — the open/reviewing states exist for the UI workflow but resolve fast (no long-lived `open` cases in prod).
- Orchestrator bails (closes + escalates with confirmed-fraud reply) if customer has ANY `status='confirmed_fraud'` OR `rule_type='amazon_reseller'`. See feedback_orchestrator_fraud_gate.
- Chargebacks don't create fraud cases anymore — only actual rules do.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
