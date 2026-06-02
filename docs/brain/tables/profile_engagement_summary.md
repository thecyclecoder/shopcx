# profile_engagement_summary

Per-(workspace, profile) engagement rollup in 30/60/90d windows. Built by RPC `rebuild_engagement_summary`. Currently empty (RPC timed out).

**Primary key:** `workspace_id`, `klaviyo_profile_id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `klaviyo_profile_id` | `text` | — |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `email` | `text` | ✓ |  |
| `phone` | `text` | ✓ |  |
| `clicked_sms_30d` | `int4` | ✓ | default: `0` |
| `clicked_sms_60d` | `int4` | ✓ | default: `0` |
| `clicked_sms_180d` | `int4` | ✓ | default: `0` |
| `opened_email_30d` | `int4` | ✓ | default: `0` |
| `opened_email_60d` | `int4` | ✓ | default: `0` |
| `opened_email_180d` | `int4` | ✓ | default: `0` |
| `clicked_email_30d` | `int4` | ✓ | default: `0` |
| `clicked_email_60d` | `int4` | ✓ | default: `0` |
| `viewed_product_30d` | `int4` | ✓ | default: `0` |
| `viewed_product_90d` | `int4` | ✓ | default: `0` |
| `added_to_cart_30d` | `int4` | ✓ | default: `0` |
| `added_to_cart_90d` | `int4` | ✓ | default: `0` |
| `checkout_started_30d` | `int4` | ✓ | default: `0` |
| `checkout_started_90d` | `int4` | ✓ | default: `0` |
| `active_on_site_30d` | `int4` | ✓ | default: `0` |
| `active_on_site_90d` | `int4` | ✓ | default: `0` |
| `last_clicked_sms_at` | `timestamptz` | ✓ |  |
| `last_opened_email_at` | `timestamptz` | ✓ |  |
| `last_clicked_email_at` | `timestamptz` | ✓ |  |
| `last_viewed_product_at` | `timestamptz` | ✓ |  |
| `last_added_to_cart_at` | `timestamptz` | ✓ |  |
| `last_checkout_started_at` | `timestamptz` | ✓ |  |
| `last_active_on_site_at` | `timestamptz` | ✓ |  |
| `last_synced_at` | `timestamptz` | ✓ | default: `now()` |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `updated_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("profile_engagement_summary")
  .select("created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("profile_engagement_summary")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("profile_engagement_summary")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
