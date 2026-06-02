# crisis_events

Crisis campaigns (e.g. Mixed Berry OOS) — affected variant, swap options, tiers, coupon. See [[../lifecycles/crisis-campaign]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `status` | `text` | — | default: `'draft'` |
| `affected_variant_id` | `text` | — |  |
| `affected_sku` | `text` | ✓ |  |
| `affected_product_title` | `text` | ✓ |  |
| `default_swap_variant_id` | `text` | ✓ |  |
| `default_swap_title` | `text` | ✓ |  |
| `available_flavor_swaps` | `jsonb` | ✓ | default: `'[]'` |
| `available_product_swaps` | `jsonb` | ✓ | default: `'[]'` |
| `tier2_coupon_code` | `text` | ✓ |  |
| `tier2_coupon_percent` | `int4` | ✓ | default: `20` |
| `expected_restock_date` | `date` | ✓ |  |
| `lead_time_days` | `int4` | ✓ | default: `7` |
| `tier_wait_days` | `int4` | ✓ | default: `3` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[crisis_customer_actions]].`crisis_id`
- [[knowledge_base]].`crisis_id`
- [[macros]].`crisis_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("crisis_events")
  .select("id, name, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("crisis_events")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("crisis_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
