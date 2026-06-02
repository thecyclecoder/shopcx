# demographics_snapshots

Per-workspace cohort demographic snapshots (frozen view of a segment at a point in time).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | ✓ | → [[products]].id |
| `total_customers` | `int4` | — | default: `0` |
| `enriched_count` | `int4` | — | default: `0` |
| `gender_distribution` | `jsonb` | — | default: `'{}'` |
| `age_distribution` | `jsonb` | — | default: `'{}'` |
| `income_distribution` | `jsonb` | — | default: `'{}'` |
| `urban_distribution` | `jsonb` | — | default: `'{}'` |
| `buyer_type_distribution` | `jsonb` | — | default: `'{}'` |
| `top_health_priorities` | `jsonb` | — | default: `'[]'` |
| `suggested_target_customer` | `text` | ✓ |  |
| `computed_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("demographics_snapshots")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
