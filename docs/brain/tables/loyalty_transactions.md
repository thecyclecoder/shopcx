# loyalty_transactions

Append-only points ledger — earn (order placed), spend (redemption), adjust (manual).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `member_id` | `uuid` | — | → [[loyalty_members]].id |
| `points_change` | `int4` | — |  |
| `type` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `order_id` | `text` | ✓ |  |
| `shopify_discount_id` | `text` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `member_id` → [[loyalty_members]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("loyalty_transactions")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("loyalty_transactions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
