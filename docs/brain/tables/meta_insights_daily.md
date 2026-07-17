# meta_insights_daily

Daily Meta performance insights at **object grain** (campaign / adset / ad).
Populated by the Storefront Iteration Engine's Phase 1 performance ingest
([[../inngest/meta-performance]]). The engine reads these (via Phase 3 scorecards)
to score and act. None existed before — only the account rollup [[daily_meta_ad_spend]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `level` | `text` | — | CHECK ∈ `campaign` \| `adset` \| `ad` |
| `meta_object_id` | `text` | — | the campaign/adset/ad id for this level |
| `snapshot_date` | `date` | — |  |
| `spend_cents` | `int8` | — | default: `0` (Meta spend dollars ×100) |
| `impressions` | `int8` | — | default: `0` |
| `clicks` | `int8` | — | default: `0` |
| `inline_link_clicks` | `int8` | ✓ | **nullable-means-unknown** — pre-migration rows stay NULL; per-mode CTR readers EXCLUDE NULLs (never treat as 0). Meta Graph field `inline_link_clicks` (Ads Manager label "Link Clicks") — a click that reached the ad's landing_url, excluding video-thumb taps, engagement clicks, CTA-only clicks. Consumed by the M3 leading-signal helper `getPerCopyModeCtrCac` ([[../specs/dahlia-cold-graded-inline-link-ctr-leading-signal]]). |
| `ctr` | `numeric` | — | default: `0` · **percent**, as reported by Meta |
| `cpc_cents` | `int8` | — | default: `0` |
| `purchases` | `int4` | — | default: `0` · from `actions[purchase]` |
| `revenue_cents` | `int8` | — | default: `0` · from `action_values[purchase]` |
| `roas` | `numeric` | — | default: `0` · derived `revenue_cents / spend_cents` |
| `frequency` | `numeric` | — | default: `0` |
| `currency` | `text` | — | default: `'USD'` |
| `synced_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Unique:** `(workspace_id, meta_object_id, level, snapshot_date)` — idempotent upsert key.

## Foreign keys

**Out (this → others):**

- `meta_ad_account_id` → [[meta_ad_accounts]].`id`
- `workspace_id` → [[workspaces]].`id`

## Gotchas

- `spend_cents`/`cpc_cents`/`revenue_cents` are **dollars ×100** (insights report currency amounts), unlike budget columns on [[meta_campaigns]]/[[meta_adsets]] which Meta returns already in minor units.
- `ctr` is a **percent** (Meta's value verbatim); `roas` is derived locally, not Meta's `purchase_roas` action.
- `meta_object_id` is NOT a uuid FK — it's the Meta id, joined to [[meta_campaigns]]/[[meta_adsets]]/[[meta_ads]] by Meta id text per `level`.
- Reconciled against [[daily_meta_ad_spend]] on ingest: sum of `level='campaign'` spend per day should match the account rollup; drift beyond tolerance (>$1 AND >2%) is surfaced (see [[../inngest/meta-performance]]).
- **Empty-while-spent is a guarded false-success (meta-insights-ingest-empty-fix).** `ingestMetaPerformance` throws + opens a `META_INGEST_EMPTY` Control Tower incident if it persists **0** rows here but [[daily_meta_ad_spend]] shows the account spent in the window — the original regression let a 133s run write 0 rows and still report `status='ok'`, starving `meta_attribution_daily.attributed_spend_cents` to 0. The ingest upserts now return rows **persisted** (not attempted) and throw on any swallowed `{ error }`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
