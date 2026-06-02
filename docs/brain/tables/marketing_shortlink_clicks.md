# marketing_shortlink_clicks

Per-click log for marketing shortlinks (`superfd.co/XXXXXX`) — timestamp, IP geo, user agent.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — |  |
| `shortlink_id` | `uuid` | — | → [[marketing_shortlinks]].id |
| `recipient_id` | `uuid` | ✓ | → [[sms_campaign_recipients]].id |
| `user_agent` | `text` | ✓ |  |
| `ip_country` | `text` | ✓ |  |
| `referrer` | `text` | ✓ |  |
| `clicked_at` | `timestamptz` | — | default: `now()` |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `recipient_id` → [[sms_campaign_recipients]].`id`
- `shortlink_id` → [[marketing_shortlinks]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("marketing_shortlink_clicks")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("marketing_shortlink_clicks")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
