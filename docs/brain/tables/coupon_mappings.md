# coupon_mappings

Shopify coupon code ↔ internal mapping with VIP tier filtering. Referenced by remedies and discount journey.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `shopify_discount_id` | `text` | — |  |
| `code` | `text` | — |  |
| `title` | `text` | ✓ |  |
| `value_type` | `text` | — |  |
| `value` | `numeric` | — |  |
| `summary` | `text` | ✓ |  |
| `use_cases` | `text[]` | — | default: `'{}'` |
| `customer_tier` | `text` | — | default: `'all'` |
| `ai_enabled` | `bool` | — | default: `true` |
| `agent_enabled` | `bool` | — | default: `true` |
| `applies_to_subscriptions` | `bool` | — | default: `true` |
| `max_uses_per_customer` | `int4` | ✓ |  |
| `notes` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("coupon_mappings")
  .select("id, title, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("coupon_mappings")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
