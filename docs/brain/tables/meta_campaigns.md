# meta_campaigns

Local mirror of Meta campaign structure + budget + status. Populated by the
Storefront Iteration Engine's Phase 1 performance ingest ([[../inngest/meta-performance]]).
No structure was stored before — only the account rollup [[daily_meta_ad_spend]].

Also seeded immediately after a media-buyer create by
[[../libraries/meta__recommendation-execute]] `reconcileCreatedAdSetToMirror`
(meta-campaign-adset-creation-primitive Phase 3) — on the same `(workspace_id,
meta_campaign_id)` natural key, so the next `syncMetaStructure` cron overwrites
cleanly with Meta's computed `effective_status` / `meta_created_time`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `meta_campaign_id` | `text` | — | Meta's campaign id (natural key) |
| `name` | `text` | ✓ |  |
| `status` | `text` | ✓ | configured: ACTIVE \| PAUSED \| ARCHIVED \| DELETED |
| `effective_status` | `text` | ✓ | Meta's computed status |
| `objective` | `text` | ✓ |  |
| `daily_budget_cents` | `int8` | ✓ | CBO campaign-level budget; null under ABO |
| `lifetime_budget_cents` | `int8` | ✓ |  |
| `meta_created_time` | `timestamptz` | ✓ | Meta's `created_time` |
| `meta_updated_time` | `timestamptz` | ✓ | Meta's `updated_time` |
| `synced_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Unique:** `(workspace_id, meta_campaign_id)` — idempotent upsert key.

## Foreign keys

**Out (this → others):**

- `meta_ad_account_id` → [[meta_ad_accounts]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None (parent links from [[meta_adsets]]/[[meta_ads]] are by Meta id text, not FK)._

## Gotchas

- Budgets are stored in **minor units (cents)** of the account currency — Meta returns budgets already in minor units, so no ×100 conversion (unlike spend, which is dollars).
- Parent/child links between meta_campaigns/[[meta_adsets]]/[[meta_ads]] are by `meta_campaign_id`/`meta_adset_id` **text**, not uuid FKs (the Meta ids are the natural keys).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
