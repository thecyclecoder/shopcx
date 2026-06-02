# klaviyo_sms_campaign_history

Historical Klaviyo SMS campaigns — message body, send time, audience segments, recomputed conversion stats.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `klaviyo_campaign_id` | `text` | — |  |
| `klaviyo_campaign_message_id` | `text` | ✓ |  |
| `channel` | `text` | — | default: `'sms'` |
| `name` | `text` | — |  |
| `status` | `text` | ✓ |  |
| `send_time` | `timestamptz` | ✓ |  |
| `scheduled_at` | `timestamptz` | ✓ |  |
| `klaviyo_created_at` | `timestamptz` | ✓ |  |
| `klaviyo_updated_at` | `timestamptz` | ✓ |  |
| `is_local_send` | `bool` | ✓ |  |
| `audience_included` | `text[]` | — | default: `'{}'` |
| `audience_excluded` | `text[]` | — | default: `'{}'` |
| `message_body` | `text` | ✓ |  |
| `message_media_url` | `text` | ✓ |  |
| `recipients` | `int4` | ✓ |  |
| `delivered` | `int4` | ✓ |  |
| `delivery_rate` | `numeric` | ✓ |  |
| `clicks` | `int4` | ✓ |  |
| `clicks_unique` | `int4` | ✓ |  |
| `click_rate` | `numeric` | ✓ |  |
| `conversions` | `int4` | ✓ |  |
| `conversion_rate` | `numeric` | ✓ |  |
| `conversion_value_cents` | `int4` | ✓ |  |
| `revenue_per_recipient_cents` | `int4` | ✓ |  |
| `average_order_value_cents` | `int4` | ✓ |  |
| `unsubscribes` | `int4` | ✓ |  |
| `unsubscribe_rate` | `numeric` | ✓ |  |
| `spam_complaints` | `int4` | ✓ |  |
| `spam_complaint_rate` | `numeric` | ✓ |  |
| `bounced` | `int4` | ✓ |  |
| `bounce_rate` | `numeric` | ✓ |  |
| `failed` | `int4` | ✓ |  |
| `failed_rate` | `numeric` | ✓ |  |
| `imported_at` | `timestamptz` | — | default: `now()` |
| `last_synced_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `initial_conversions` | `int4` | ✓ |  |
| `initial_conversion_value_cents` | `int4` | ✓ |  |
| `initial_average_order_value_cents` | `int4` | ✓ |  |
| `initial_revenue_computed_at` | `timestamptz` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("klaviyo_sms_campaign_history")
  .select("id, name, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("klaviyo_sms_campaign_history")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("klaviyo_sms_campaign_history")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
