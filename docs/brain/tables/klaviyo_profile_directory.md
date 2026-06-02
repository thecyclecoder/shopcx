# klaviyo_profile_directory

Klaviyo profile metadata cache — id, email, phone, attributes — used for staging+matching during enrichment.

**Primary key:** `workspace_id`, `klaviyo_profile_id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `klaviyo_profile_id` | `text` | — |  |
| `email` | `text` | ✓ |  |
| `phone` | `text` | ✓ |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `last_synced_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("klaviyo_profile_directory")
  .select("workspace_id, klaviyo_profile_id, email, phone, customer_id, last_synced_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("klaviyo_profile_directory")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
