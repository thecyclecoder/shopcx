# media_buyer_test_cohorts

Per-workspace **test-ad-set + daily-ceiling configuration** for the Media Buyer agent — the CONTROLLED autonomous go-live rail behind [[../specs/media-buyer-test-winner-loop]] Phase 1. One row marks EXACTLY ONE Meta ad set as the "test cohort" the Media Buyer is allowed to publish live into, plus a per-day USD ceiling that caps that ad set's spend.

The Phase 1 publish path ([[../inngest/ad-tool]] `adToolPublishToMeta` + the `POST /api/ads/campaigns/[id]/publish` route) reads this table via [[../libraries/media-buyer-publish-gate]] `evaluateMediaBuyerTestPublish` on any job flagged `origin='media-buyer-test'`. A wrong ad set OR an over-ceiling projection REFUSES the live flag — the ad publishes PAUSED and the gate escalates to the CEO's approval inbox (per [[../operational-rules]] § North star — hit a rail = escalate, not execute).

**Distinct from two neighbouring concepts** — keep them straight:

- [[ad_spend_budgets]] caps the workspace's ROLLING-WINDOW ad DOLLARS ([[../libraries/ad-spend-governor]]) — a standing supervisor's leash, evaluated on cadence, escalates on a trend over. This table caps the DAILY BUDGET of ONE specific ad set at PUBLISH time — the entry rail for the autonomous go-live, not the standing supervisor.
- [[iteration_policies]] `per_account_daily_budget_delta_ceiling_cents` caps a **single PASS** of budget MOTION (how much the iteration loop may move an account's daily budget in one optimizer step). This table caps the ad-set's ABSOLUTE daily budget for the Media Buyer's test cohort.

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); `meta_ad_account_id` AND `product_id` are optional:

- `meta_ad_account_id` — `NULL` = the workspace's single-account default; a non-null row scopes the cohort to one connected Meta ad account. `getEffectiveMediaBuyerTestCohort` reads the most-specific row available.
- `product_id` — `NULL` = the (workspace, account) DEFAULT cohort (Superfood Tabs's shape today, and the fallback when a product doesn't have its own row); a non-null row is a per-product cohort in a shared Meta ad account so each product carries its own adset + ceiling ([[../specs/media-buyer-product-scoped-test-rail]] Phase 1 — Amazing Coffee + Creamer share one account @ 600 each; Ashwavana Guru Focus + Zen Relax share one @ 600 each). `getEffectiveMediaBuyerTestCohort(workspace, account, productId?)` resolves the product-specific `(account, product)` row first, then the null-product account default, then the workspace-wide null-account default — Superfood Tabs is unaffected because its callers omit the productId and the null-product default keeps returning.
- `is_active` — the switch. `false` = dormant (opt-out from the autonomous go-live), treated identically to "no row" by the gate. A partial unique index enforces one ACTIVE row per (workspace, meta_ad_account, product) — a shared account can hold both a null-product default AND one row per product simultaneously.

**Owner-editable, service-role-written.** A workspace member can `SELECT` (RLS); writes go through the service role from the (future) Media Buyer admin surface, never client-side.

**No seed.** Ships empty — the Media Buyer's autonomous go-live is dormant until the workspace owner opts in by designating a test ad set + ceiling.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace-wide default; non-null = per-account cohort |
| `product_id` | `uuid?` | **[[../specs/media-buyer-product-scoped-test-rail]] Phase 1** — → [[products]].id · `NULL` = the (workspace, account) default cohort; non-null = a per-product cohort in a shared Meta ad account so each product gets its own adset + ceiling. |
| `test_meta_adset_id` | `text` | NOT NULL · bare Meta ad-set id (client adds no prefix) |
| `daily_test_ceiling_cents` | `bigint` | NOT NULL · daily USD ceiling in CENTS applied to the test ad set · `> 0` |
| `is_active` | `bool` | NOT NULL default `true` · `false` = dormant (gate treats as no active cohort) |
| `default_meta_account_id` | `text?` | **Phase 2** — bare Meta ad-account id the Media Buyer runner uses when inserting replenish `ad_publish_jobs` rows. NULL = replenish deferred with `media_buyer_replenish_missing_config`. |
| `default_meta_page_id` | `text?` | **Phase 2** — bare Meta page id used for the creative's `object_story_spec.page_id`. NULL = replenish deferred. |
| `default_meta_instagram_user_id` | `text?` | **Phase 2** — the page's linked IG account id. NULL is fine (the publisher tolerates a null IG id). |
| `green_min_coverage` | `numeric?` | **[[../specs/media-buyer-sensor-trust-probe]] Phase 1** — attribution coverage ratio at or above which the [[media_buyer_sensor_trust]] probe emits `band='green'`. NULL = fall back to the Phase 2 code-level default. |
| `yellow_min_coverage` | `numeric?` | **[[../specs/media-buyer-sensor-trust-probe]] Phase 1** — coverage ratio at or above which the probe emits `band='yellow'` (below `green_min_coverage`). Under this floor → `band='red'`. NULL = code-level default. |
| `max_unresolved_share` | `numeric?` | **[[../specs/media-buyer-sensor-trust-probe]] Phase 1** — cap on `unresolved_revenue_share` before the probe drops the band toward `red`. NULL = code-level default. |
| `notes` | `text?` | owner notes — surfaced on the editor |
| `updated_by` | `uuid?` | → `auth.users.id` · ON DELETE SET NULL · `NULL` when a service-role script writes |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `media_buyer_test_cohorts_touch_updated_at` trigger |

## Indexes

- `media_buyer_test_cohorts_ws_account_product_active_key` — UNIQUE `(workspace_id, coalesce(meta_ad_account_id::text, ''), coalesce(product_id::text, ''))` WHERE `is_active = true`. One active cohort per (workspace, meta_ad_account, product) — a shared account can hold both a null-product default AND one active row per product ([[../specs/media-buyer-product-scoped-test-rail]] Phase 1, replacing the pre-Phase-1 (workspace, meta_ad_account) index). Flipping `is_active=false` on the current row is the retire path.

## Triggers

- `media_buyer_test_cohorts_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## Who writes / reads

- **Writer:** (Phase 1) via a one-off `INSERT` from the owner today; a future Media Buyer admin surface will upsert through a service-role API. Never client-side.
- **Reader:** [[../libraries/media-buyer-publish-gate]] `getEffectiveMediaBuyerTestCohort` on every `origin='media-buyer-test'` publish — through both the publish route AND [[../inngest/ad-tool]] `adToolPublishToMeta`'s defensive re-check.

## Gotchas

- **Opt-in — empty table = no autonomous go-live.** A missing row is the DEFAULT — the gate REFUSES a media-buyer-test publish with `reason='no_active_cohort'` + escalation. That is the correct behaviour; the Media Buyer never spends until the owner designates a cohort.
- **`is_active=false` is dormant, not deleted.** Retire the current cohort by flipping it to inactive; the audit trail (`updated_by`/`updated_at`) survives. A dormant row is treated identically to "no row" by the gate.
- **One live cohort at a time (per workspace + account).** The partial unique index blocks a second active row for the same scope. To swap cohorts, retire the current one first (or wrap the swap in a transaction).
- **Per-account row beats workspace-wide.** A workspace can hold both a per-account row and a workspace-wide (`meta_ad_account_id IS NULL`) row; `getEffectiveMediaBuyerTestCohort` returns the more-specific one for the requested account.
- **Per-product row beats null-product account default** ([[../specs/media-buyer-product-scoped-test-rail]] Phase 1). Resolution order: `(account, productId)` → `(account, product NULL)` → `(account NULL, product NULL)`. A caller that omits `productId` (Superfood Tabs today) still gets the null-product account default, so nothing regresses.
- **`product_id` is nullable + additive.** The null-product row is the DEFAULT for any product that hasn't been carved out yet. Two products sharing a Meta ad account get their own rows; each stays in its own adset + ceiling.
- **`test_meta_adset_id` is a BARE Meta id (text), not our UUID.** The gate compares it string-equal to the requested `meta_adset_id`.
- **`bigint` arrives as a string from PostgREST.** `toCohort` normalizes `daily_test_ceiling_cents` to `number` so callers don't have to.

## Migration

- **Phase 1:** `supabase/migrations/20260707120000_media_buyer_test_cohorts.sql` — apply with `npx tsx scripts/apply-media-buyer-test-cohorts-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards, `add column if not exists` on `ad_publish_jobs.origin`). RLS: service-role full access + workspace-member SELECT (mirrors [[ad_spend_budgets]]).
- **Phase 2:** `supabase/migrations/20260707130000_media_buyer_test_cohorts_publish_targets.sql` — additive; adds `default_meta_account_id`, `default_meta_page_id`, `default_meta_instagram_user_id` (all NULLABLE) so the Media Buyer runner can insert replenish `ad_publish_jobs` rows. Apply with `npx tsx scripts/apply-media-buyer-test-cohorts-publish-targets-migration.ts`.
- **[[../specs/media-buyer-sensor-trust-probe]] Phase 1:** `supabase/migrations/20260928130000_media_buyer_test_cohorts_sensor_trust_thresholds.sql` — additive; adds `green_min_coverage`, `yellow_min_coverage`, `max_unresolved_share` (all NULLABLE) so the cohort owner authors the [[media_buyer_sensor_trust]] bands. Apply with `npx tsx scripts/apply-media-buyer-sensor-trust-migration.ts`.
- **[[../specs/media-buyer-product-scoped-test-rail]] Phase 1:** `supabase/migrations/20261015120000_media_buyer_cohort_product.sql` — additive; adds `product_id` (NULLABLE → [[products]].id) so a shared Meta ad account can hold one cohort per product. Replaces the pre-Phase-1 partial unique index on `(workspace_id, meta_ad_account_id)` with `media_buyer_test_cohorts_ws_account_product_active_key` on `(workspace_id, meta_ad_account_id, product_id)` WHERE `is_active`. Fully idempotent (`add column if not exists`, `drop index if exists`, `create unique index if not exists`). Apply with `npx tsx scripts/apply-media-buyer-cohort-product-migration.ts`.

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[products]] · [[ad_publish_jobs]] · [[ad_spend_budgets]] · [[iteration_policies]] · [[director_activity]] · [[media_buyer_sensor_trust]] · [[../libraries/media-buyer-publish-gate]] · [[../lifecycles/ad-publish]] · [[../specs/media-buyer-test-winner-loop]] · [[../specs/media-buyer-sensor-trust-probe]] · [[../specs/media-buyer-product-scoped-test-rail]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
