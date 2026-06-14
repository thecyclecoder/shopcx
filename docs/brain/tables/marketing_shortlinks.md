# marketing_shortlinks

Shortlink slug ↔ target URL ↔ campaign mapping. Crockford base32 6-char slug, per-workspace `shortlink_domain`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `slug` | `text` | — |  |
| `target_url` | `text` | — |  |
| `campaign_id` | `uuid` | ✓ | → [[sms_campaigns]].id |
| `click_count` | `int4` | — | default: `0` |
| `first_clicked_at` | `timestamptz` | ✓ |  |
| `last_clicked_at` | `timestamptz` | ✓ |  |
| `is_active` | `bool` | — | default: `true` |
| `expires_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `campaign_id` → [[sms_campaigns]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[marketing_shortlink_clicks]].`shortlink_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("marketing_shortlinks")
  .select("id, slug, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("marketing_shortlinks")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Crockford base32, 6 chars, ~1B namespace.
- Per-workspace shortlink_domain on `workspaces.shortlink_domain`. Subdomain routing via middleware.
- **The slug is only the *link code*.** SMS marketing identifies the recipient via a **second path segment**: `superfd.co/{slug}/{customers.short_code}` (e.g. `superfd.co/AB12CD/00059`). `/api/sl/[slug]` reads that trailing customer code → attributes the click + sets `sx_customer`. The bare `superfd.co/{slug}` form carries NO per-user attribution. See [[../inngest/marketing-text]] § Per-recipient shortlink format.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
