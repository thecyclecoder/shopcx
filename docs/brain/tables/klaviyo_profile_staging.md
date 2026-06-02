# klaviyo_profile_staging

Staging table for Klaviyo profile imports before they're merged into `customers`.

**Primary key:** `workspace_id`, `klaviyo_profile_id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `klaviyo_profile_id` | `text` | — |  |
| `email` | `text` | ✓ |  |
| `phone` | `text` | ✓ |  |
| `first_name` | `text` | ✓ |  |
| `last_name` | `text` | ✓ |  |
| `anonymous_id` | `text` | ✓ |  |
| `external_id` | `text` | ✓ |  |
| `locale` | `text` | ✓ |  |
| `address1` | `text` | ✓ |  |
| `address2` | `text` | ✓ |  |
| `city` | `text` | ✓ |  |
| `region` | `text` | ✓ |  |
| `zip` | `text` | ✓ |  |
| `country` | `text` | ✓ |  |
| `latitude` | `float8` | ✓ |  |
| `longitude` | `float8` | ✓ |  |
| `timezone` | `text` | ✓ |  |
| `ip_address` | `text` | ✓ |  |
| `klaviyo_created` | `timestamptz` | ✓ |  |
| `klaviyo_updated` | `timestamptz` | ✓ |  |
| `klaviyo_last_event_date` | `timestamptz` | ✓ |  |
| `utm_source` | `text` | ✓ |  |
| `utm_medium` | `text` | ✓ |  |
| `utm_campaign` | `text` | ✓ |  |
| `utm_content` | `text` | ✓ |  |
| `consent_form_id` | `text` | ✓ |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `resolution_method` | `text` | ✓ |  |
| `source_segment` | `text` | ✓ |  |
| `synced_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("klaviyo_profile_staging")
  .select("workspace_id, klaviyo_profile_id, email, phone, first_name, last_name")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("klaviyo_profile_staging")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
