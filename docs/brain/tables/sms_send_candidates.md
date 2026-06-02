# sms_send_candidates

Pre-computed per-(profile, campaign) feature snapshot used at send time for predicted-buyer segment matching.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `campaign_id` | `uuid` | — | → [[sms_campaigns]].id |
| `customer_id` | `uuid` | ✓ |  |
| `phone` | `text` | — |  |
| `scheduled_send_at` | `timestamptz` | — |  |
| `resolved_timezone` | `text` | ✓ |  |
| `timezone_source` | `text` | ✓ |  |
| `preferred_hour_used` | `int4` | ✓ |  |
| `priority` | `int4` | — | default: `100` |
| `outcome` | `text` | — | default: `'staged'` |
| `promoted_recipient_id` | `uuid` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `campaign_id` → [[sms_campaigns]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("sms_send_candidates")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("sms_send_candidates")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("sms_send_candidates")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
