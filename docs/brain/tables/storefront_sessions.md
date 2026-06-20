# storefront_sessions

One row per anonymous_id. Device fingerprint, UTMs, click IDs, _fbp/_fbc cookies, IP-derived geo. Indefinite retention.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `anonymous_id` | `text` | — |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `is_internal` | `bool` | — | default: `false`. Team/testing traffic — excluded from the storefront funnel. Set by `/api/pixel` when the `sx_internal` cookie is present (visit any storefront page with `?sx_internal=1` to flag a device, `?sx_internal=0` to clear). The funnel also treats a session as internal if its `customer_id` is an internal [[customers]] row. |
| `is_bot` | `bool` | — | default: `false`. Datacenter/crawler traffic (Meta ad-review bots) — excluded from the funnel. Set by `/api/pixel` when the request IP is a datacenter/Meta network ([[../libraries/datacenter-ip]]); only the boolean is stored, never the IP. |
| `first_seen_at` | `timestamptz` | — | default: `now()` |
| `last_seen_at` | `timestamptz` | — | default: `now()` |
| `user_agent` | `text` | ✓ |  |
| `device_type` | `text` | ✓ |  |
| `os` | `text` | ✓ |  |
| `browser` | `text` | ✓ |  |
| `viewport_width` | `int4` | ✓ |  |
| `viewport_height` | `int4` | ✓ |  |
| `ip_country` | `text` | ✓ |  |
| `ip_region` | `text` | ✓ |  |
| `ip_city` | `text` | ✓ |  |
| `landing_url` | `text` | ✓ |  |
| `referrer` | `text` | ✓ |  |
| `utm_source` | `text` | ✓ |  |
| `utm_medium` | `text` | ✓ |  |
| `utm_campaign` | `text` | ✓ |  |
| `utm_content` | `text` | ✓ |  |
| `utm_term` | `text` | ✓ |  |
| `fbclid` | `text` | ✓ |  |
| `gclid` | `text` | ✓ |  |
| `ttclid` | `text` | ✓ |  |
| `fbp` | `text` | ✓ |  |
| `fbc` | `text` | ✓ |  |
| `advertorial_page_id` | `uuid` | ✓ | → [[advertorial_pages]].id · FK `on delete set null`. Phase 2b — resolved lander identity stamped at pixel time. `/api/pixel` `resolveLanderIds()` parses `?angle={slug}` from `landing_url` → `advertorial_pages` (slug is unique per workspace+product, suffix-encodes variant). Stamped at first INSERT **and** re-resolved **set-when-null** on later pixel hits (advertorial-attribution-fix): a session whose first touch landed without a resolving angle is healed when a later hit carries the `?angle=`. Never overwrites a non-null; `landing_url` itself stays insert-only. Null for non-lander landings. Backfilled from `landing_url`'s `?angle=` by `scripts/backfill-advertorial-page-id.ts` (recent window, then all-time). |
| `ad_campaign_id` | `uuid` | ✓ | → [[ad_campaigns]].id · FK `on delete set null`. Phase 2b — the resolved page's `campaign_id`, stamped alongside `advertorial_page_id`. |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `advertorial_page_id` → [[advertorial_pages]].`id` (on delete set null)
- `ad_campaign_id` → [[ad_campaigns]].`id` (on delete set null)
- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[storefront_events]].`session_id`
- [[storefront_leads]].`session_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("storefront_sessions")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("storefront_sessions")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("storefront_sessions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- One row per anonymous_id (the `sid` cookie). 365-day cookie.
- Indefinite retention — no raw PII; only IP-derived geo + UTMs + device fingerprint.
- `customer_id` backfilled when the user identifies (lead capture / checkout / portal login).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
