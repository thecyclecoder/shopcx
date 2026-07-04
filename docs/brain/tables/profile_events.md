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

## Indexes

| Index | Columns | Notes |
|---|---|---|
| `profile_events_pkey` | `id` | Primary key |
| `profile_events_workspace_customer_idx` | `workspace_id`, `customer_id` | Join support |
| `profile_events_workspace_metric_idx` | `workspace_id`, `metric_name` | Metric rollup queries |
| `profile_events_workspace_datetime_idx` | `workspace_id`, `datetime` | Time-range scans |
| `profile_events_klaviyo_event_id_idx` | `klaviyo_event_id` | Dedup on upsert |
| `profile_events_campaign_idx` | `workspace_id`, `attributed_klaviyo_campaign_id` | Campaign attribution lookups |
| `profile_events_metric_dt` | `workspace_id`, `metric_name`, `datetime` | Metric × time composite (workspace × metric × time scan) |

**Dropped (2026-08-19):** `klaviyo_profile_events_profile_metric_dt` was a duplicate composite index with zero usage (pg_stat_user_indexes idx_scan == 0). The DB Health Agent flagged it; dropped via migration `20260819120000_drop_klaviyo_profile_events_profile_metric_dt_index.sql` ([[../libraries/db-health]] analyzeIndexUsage). Maintenance cost was paid on every Klaviyo event insert without backing any read path.

## Gotchas

- **`Received SMS`** is produced by [[../inngest/sms-callback-drain]] `received-sms-rollup-cron` (every 5 min) — NOT by the Twilio status-callback webhook path (moved off the hot path in Phase 4 of the twilio-callback-queue-drain feature, archived 2026-07-04). `datetime` is the recipient's `delivered_at` (when Twilio actually delivered), not the rollup's `now()`. Exactly one row per delivered recipient — the cron marks `sms_campaign_recipients.received_sms_logged_at` after emitting, so a second pass picks zero candidates.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
