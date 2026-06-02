# monthly_revenue_snapshots

Per-month revenue rollup for trend dashboards.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `month` | `text` | — |  |
| `recurring_count` | `int4` | — | default: `0` |
| `recurring_revenue_cents` | `int4` | — | default: `0` |
| `new_subscription_count` | `int4` | — | default: `0` |
| `new_subscription_revenue_cents` | `int4` | — | default: `0` |
| `one_time_count` | `int4` | — | default: `0` |
| `one_time_revenue_cents` | `int4` | — | default: `0` |
| `replacement_count` | `int4` | — | default: `0` |
| `total_count` | `int4` | — | default: `0` |
| `total_revenue_cents` | `int4` | — | default: `0` |
| `mrr_cents` | `int4` | — | default: `0` |
| `churn_cents` | `int4` | — | default: `0` |
| `churn_pct` | `numeric` | — | default: `0` |
| `prev_mrr_cents` | `int4` | — | default: `0` |
| `net_mrr_cents` | `int4` | — | default: `0` |
| `subscription_rate` | `numeric` | — | default: `0` |
| `days` | `int4` | — | default: `0` |
| `days_in_month` | `int4` | — | default: `0` |
| `is_complete` | `bool` | — | default: `false` |
| `mismatches` | `int4` | — | default: `0` |
| `amz_recurring_count` | `int4` | — | default: `0` |
| `amz_recurring_revenue_cents` | `int4` | — | default: `0` |
| `amz_sns_checkout_count` | `int4` | — | default: `0` |
| `amz_sns_checkout_revenue_cents` | `int4` | — | default: `0` |
| `amz_one_time_count` | `int4` | — | default: `0` |
| `amz_one_time_revenue_cents` | `int4` | — | default: `0` |
| `amz_total_count` | `int4` | — | default: `0` |
| `amz_total_revenue_cents` | `int4` | — | default: `0` |
| `amz_mrr_cents` | `int4` | — | default: `0` |
| `amz_churn_cents` | `int4` | — | default: `0` |
| `amz_churn_pct` | `numeric` | — | default: `0` |
| `amz_subscription_rate` | `numeric` | — | default: `0` |
| `computed_at` | `timestamptz` | — | default: `now()` |
| `meta_spend_cents` | `int4` | — | default: `0` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("monthly_revenue_snapshots")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
