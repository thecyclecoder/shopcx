# klaviyo_events

Imported Klaviyo events (Placed Order primarily) with UTM-attribution parsed back to `attributed_klaviyo_campaign_id`. See TEXT-MARKETING.md.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `klaviyo_event_id` | `text` | — |  |
| `klaviyo_metric_id` | `text` | — |  |
| `klaviyo_profile_id` | `text` | ✓ |  |
| `datetime` | `timestamptz` | — |  |
| `value` | `numeric` | ✓ |  |
| `source_name` | `text` | ✓ |  |
| `order_number` | `text` | ✓ |  |
| `event_properties` | `jsonb` | — | default: `'{}'` |
| `imported_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `attributed_klaviyo_campaign_id` | `text` | ✓ |  |
| `attributed_utm_source` | `text` | ✓ |  |
| `attributed_utm_medium` | `text` | ✓ |  |
| `attributed_utm_campaign` | `text` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("klaviyo_events")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("klaviyo_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Placed Order events parsed for `attributed_klaviyo_campaign_id` from `utm_campaign`'s parenthesized id.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
