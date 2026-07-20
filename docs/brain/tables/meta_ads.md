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
- **Drop-out reconcile:** Meta's default `/ads` list excludes deleted ads, so a deleted ad keeps its stale ACTIVE mirror row forever. After each `syncMetaStructure` upsert, the mirror rows for the synced campaigns are diffed against Meta's returned ad ids by the pure `reconcileDroppedAdIds` helper in [[../libraries/meta__performance]], and any drop-out is flipped to `status='ARCHIVED'`, `effective_status='ARCHIVED'` — scoped to the synced campaigns, never account-wide. A dropped AD leaves the same ghost the Ad Testing creative view + ad-level signals read.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
