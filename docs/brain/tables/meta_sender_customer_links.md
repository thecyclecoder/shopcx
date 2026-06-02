# meta_sender_customer_links

Meta-sender-id ↔ internal customer_id mapping. Built from Conversations API on DM.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_sender_id` | `text` | — |  |
| `meta_sender_name` | `text` | ✓ |  |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `confirmed_by` | `uuid` | ✓ |  |
| `confirmed_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("meta_sender_customer_links")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("meta_sender_customer_links")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
