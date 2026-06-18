# meta_ads

Local mirror of Meta ad structure + status. Populated by the Storefront Iteration
Engine's Phase 1 performance ingest ([[../inngest/meta-performance]]).

ShopCX-built ads map to these rows via the existing
[[ad_publish_jobs]]`.meta_ad_id`/`meta_adset_id`/`meta_campaign_id` (no new column).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `meta_ad_id` | `text` | — | Meta's ad id (natural key) |
| `meta_adset_id` | `text` | ✓ | parent adset (Meta id) → [[meta_adsets]].meta_adset_id |
| `meta_campaign_id` | `text` | ✓ | parent campaign (Meta id) → [[meta_campaigns]].meta_campaign_id |
| `name` | `text` | ✓ |  |
| `status` | `text` | ✓ | configured: ACTIVE \| PAUSED \| ARCHIVED \| DELETED |
| `effective_status` | `text` | ✓ | Meta's computed status |
| `creative_id` | `text` | ✓ | Meta ad-creative id |
| `meta_created_time` | `timestamptz` | ✓ |  |
| `meta_updated_time` | `timestamptz` | ✓ |  |
| `synced_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Unique:** `(workspace_id, meta_ad_id)` — idempotent upsert key.

## Foreign keys

**Out (this → others):**

- `meta_ad_account_id` → [[meta_ad_accounts]].`id`
- `workspace_id` → [[workspaces]].`id`

## Gotchas

- Parent links (`meta_adset_id`/`meta_campaign_id`) are **text Meta ids**, not uuid FKs.
- ShopCX-published ads join back to [[ad_campaigns]] via [[ad_publish_jobs]]`.meta_ad_id` (Phase 2 attribution / Phase 3 per-angle scorecards).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
