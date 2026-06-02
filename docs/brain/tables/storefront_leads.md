# storefront_leads

Lead-capture events on the storefront. Customer is created/matched, this row logs the capture surface.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `email` | `text` | ✓ |  |
| `phone` | `text` | ✓ |  |
| `email_consent_at` | `timestamptz` | ✓ |  |
| `sms_consent_at` | `timestamptz` | ✓ |  |
| `anonymous_id` | `text` | ✓ |  |
| `session_id` | `uuid` | ✓ | → [[storefront_sessions]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `source` | `text` | ✓ |  |
| `coupon_code_issued` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `session_id` → [[storefront_sessions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("storefront_leads")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("storefront_leads")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("storefront_leads")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
