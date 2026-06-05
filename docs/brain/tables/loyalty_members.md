# loyalty_members

Per-(workspace, customer) loyalty enrollment + tier + points balance.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `shopify_customer_id` | `text` | ✓ |  |
| `email` | `text` | ✓ |  |
| `points_balance` | `int4` | — | default: `0` |
| `points_earned` | `int4` | — | default: `0` |
| `points_spent` | `int4` | — | default: `0` |
| `source` | `text` | — | default: `'native'` |
| `needs_points_backfill` | `bool` | — | default: `false` · set by the points audit when a member is owed earn-points for pre-pipeline orders; cleared by the backfill script after crediting. Partial index `idx_loyalty_members_needs_backfill` on `(workspace_id) where needs_points_backfill = true`. |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `updated_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[loyalty_redemptions]].`member_id`
- [[loyalty_transactions]].`member_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("loyalty_members")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("loyalty_members")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Shopify boundary lookup (webhook ingest only — never for internal joins)
```ts
const { data } = await admin.from("loyalty_members")
  .select("*").eq("shopify_customer_id", shopifyId).maybeSingle();
```

### Count since a given time
```ts
const { count } = await admin.from("loyalty_members")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
