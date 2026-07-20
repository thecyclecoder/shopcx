# meta_adsets

Local mirror of Meta ad set structure + budget + status. Populated by the
Storefront Iteration Engine's Phase 1 performance ingest ([[../inngest/meta-performance]]).

Also seeded immediately after a media-buyer create by
[[../libraries/meta__recommendation-execute]] `reconcileCreatedAdSetToMirror`
(meta-campaign-adset-creation-primitive Phase 3) — on the same `(workspace_id,
meta_adset_id)` natural key, so the next `syncMetaStructure` cron overwrites
cleanly with Meta's computed `effective_status` / `meta_created_time`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `meta_adset_id` | `text` | — | Meta's adset id (natural key) |
| `meta_campaign_id` | `text` | ✓ | parent campaign (Meta id) → [[meta_campaigns]].meta_campaign_id |
| `name` | `text` | ✓ |  |
| `status` | `text` | ✓ | configured: ACTIVE \| PAUSED \| ARCHIVED \| DELETED |
| `effective_status` | `text` | ✓ | Meta's computed status |
| `optimization_goal` | `text` | ✓ |  |
| `daily_budget_cents` | `int8` | ✓ | ABO adset-level budget; null under CBO |
| `lifetime_budget_cents` | `int8` | ✓ |  |
| `meta_created_time` | `timestamptz` | ✓ |  |
| `meta_updated_time` | `timestamptz` | ✓ |  |
| `synced_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Unique:** `(workspace_id, meta_adset_id)` — idempotent upsert key.

## Foreign keys

**Out (this → others):**

- `meta_ad_account_id` → [[meta_ad_accounts]].`id`
- `workspace_id` → [[workspaces]].`id`

## Gotchas

- Budgets in **cents** (Meta returns minor units already — no ×100).
- `meta_campaign_id` links to [[meta_campaigns]] by **text Meta id**, not uuid FK.
- Either `daily_budget_cents` (here, ABO) or [[meta_campaigns]]`.daily_budget_cents` (CBO) is set, not both.
- **Drop-out reconcile:** Meta's default `/adsets` list EXCLUDES archived adsets, so an
  archived adset would keep its stale ACTIVE mirror row forever (Superfood Tabs incident:
  two adsets stuck ACTIVE until reconciled by hand). After each `syncMetaStructure` upsert,
  the mirror rows for the synced campaigns are diffed against Meta's returned adset ids by
  the pure `reconcileDroppedAdsetIds` helper in [[../libraries/meta__performance]], and any
  drop-out is flipped to `status='ARCHIVED'`, `effective_status='ARCHIVED'` — scoped to the
  synced campaigns, never account-wide.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
