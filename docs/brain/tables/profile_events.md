# profile_events

Engagement events: Clicked SMS, Opened/Clicked Email, Active on Site, Viewed Product, Added to Cart, Checkout Started, Received SMS.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `int8` | — |  |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `klaviyo_profile_id` | `text` | ✓ |  |
| `klaviyo_event_id` | `text` | ✓ |  |
| `metric_name` | `text` | — |  |
| `datetime` | `timestamptz` | — |  |
| `value_cents` | `int4` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `attributed_campaign_id` | `text` | ✓ |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("profile_events")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("profile_events")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("profile_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **`Received SMS`** is produced by [[../inngest/sms-callback-drain]] `received-sms-rollup-cron` (every 5 min) — NOT by the Twilio status-callback webhook path (moved off the hot path in Phase 4 of the twilio-callback-queue-drain feature, archived 2026-07-04). `datetime` is the recipient's `delivered_at` (when Twilio actually delivered), not the rollup's `now()`. Exactly one row per delivered recipient — the cron marks `sms_campaign_recipients.received_sms_logged_at` after emitting, so a second pass picks zero candidates.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
