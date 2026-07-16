# media_buyer_test_cohorts

Per-workspace **test-ad-set + daily-ceiling configuration** for the Media Buyer agent — the CONTROLLED autonomous go-live rail behind [[../specs/media-buyer-test-winner-loop]] Phase 1. One row marks EXACTLY ONE Meta ad set as the "test cohort" the Media Buyer is allowed to publish live into, plus a per-day USD ceiling that caps that ad set's spend.

The Phase 1 publish path ([[../inngest/ad-tool]] `adToolPublishToMeta` + the `POST /api/ads/campaigns/[id]/publish` route) reads this table via [[../libraries/media-buyer-publish-gate]] `evaluateMediaBuyerTestPublish` on any job flagged `origin='media-buyer-test'`. A wrong ad set OR an over-ceiling projection (legacy mode), or a per-adset-budget / concurrency / config breach (per-test mode), REFUSES the live flag — the ad publishes PAUSED and the gate escalates to the CEO's approval inbox (per [[../operational-rules]] § North star — hit a rail = escalate, not execute). Two cohort shapes: **legacy** (`adset_per_test=false`) publishes into one shared `test_meta_adset_id`; **per-test** (`adset_per_test=true`, CEO 2026-07-12) mints a fresh $150 adset per creative under `test_meta_campaign_id` (the researched ABO model — see the per-test gotcha below).

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
| `test_meta_adset_id` | `text?` | bare Meta ad-set id (client adds no prefix) — the single SHARED test adset (legacy `adset_per_test=false`). **NULL for per-test cohorts** (they mint a fresh adset per creative). Enforced by `media_buyer_test_cohorts_adset_shape_chk`: non-null unless `adset_per_test`. |
| `daily_test_ceiling_cents` | `bigint` | NOT NULL · daily USD ceiling in CENTS · `> 0`. In per-test mode this is the WHOLE-cohort ceiling ($600) and `÷ per_test_daily_budget_cents` = max concurrent tests. |
| `adset_per_test` | `bool` | **Per-test model (CEO 2026-07-12)** — NOT NULL default `false`. `false` = legacy single shared adset. `true` = the replenish mints a fresh `per_test_daily_budget_cents` ad set per test creative under `test_meta_campaign_id`. |
| `test_meta_campaign_id` | `text?` | The ABO testing campaign per-test adsets are created under ([[../libraries/meta-ads]] `getOrCreateTestingCampaign`). NULL for legacy cohorts. |
| `per_test_daily_budget_cents` | `int` | NOT NULL default `15000` ($150). The fixed daily budget each per-test adset carries. |
| `adset_template` | `jsonb?` | The cloned adset spec (`optimizationGoal`/`billingEvent`/`bidStrategy`/`pixelId`/`customEventType`/`targeting`) applied to every per-test adset so only the CREATIVE varies. NULL for legacy cohorts. **Freshly-provisioned rows inherit F50-65 targeting** ([[../specs/bianca-cold-test-audience-align-to-f50-65-converter]] Phase 1) — [[../libraries/provision-cohort]] `DEFAULT_TEST_TARGETING` = US women 50-65 (home+recent, Advantage+ Audience on) per [[../reference/meta-scaling-methodology]] § "Test audience held constant", so the per-creative CPA read is a clean signal against the customer the cold-50+ creative is meant to sell. Pre-2026-07-16 rows still carrying the 18-65 shape are re-aligned by the Phase-2 one-shot idempotent backfill. |
| `is_active` | `bool` | NOT NULL default `true` · `false` = dormant (gate treats as no active cohort) |
| `default_meta_account_id` | `text?` | **Phase 2** — bare Meta ad-account id the Media Buyer runner uses when inserting replenish `ad_publish_jobs` rows. NULL = replenish deferred with `media_buyer_replenish_missing_config`. |
| `default_meta_page_id` | `text?` | **Phase 2** — bare Meta page id used for the creative's `object_story_spec.page_id`. NULL = replenish deferred. |
| `default_meta_instagram_user_id` | `text?` | **Phase 2** — the page's linked IG account id. NULL is fine (the publisher tolerates a null IG id). |
| `green_min_coverage` | `numeric?` | **[[../specs/media-buyer-sensor-trust-probe]] Phase 1** — attribution coverage ratio at or above which the [[media_buyer_sensor_trust]] probe emits `band='green'`. NULL = fall back to the Phase 2 code-level default. |
| `yellow_min_coverage` | `numeric?` | **[[../specs/media-buyer-sensor-trust-probe]] Phase 1** — coverage ratio at or above which the probe emits `band='yellow'` (below `green_min_coverage`). Under this floor → `band='red'`. NULL = code-level default. |
| `max_unresolved_share` | `numeric?` | **[[../specs/media-buyer-sensor-trust-probe]] Phase 1** — cap on `unresolved_revenue_share` before the probe drops the band toward `red`. NULL = code-level default. |
| `excluded_purchaser_audience_id` | `text?` | **[[../specs/bianca-cold-test-recent-purchaser-exclusion]] Phase 1** — bare Meta customaudience id (client adds no prefix — NOT our uuid) of the pixel-side "last-180d purchasers" website custom audience the cohort must exclude on every per-test ad set. NULL = no exclusion stamped yet (legacy pre-Phase-1 row; the Phase 3 backfill stamps it, and Phase 2's `provisionProductTestCohort` stamps it on fresh rows via `getOrCreateRecentPurchaserAudience`). The publish-gate refuses a per-test publish whose `targeting.excluded_custom_audiences` does not carry this id (`reason='missing_purchaser_exclusion'`). One of TWO exclusion audiences composed into the same list — the sibling customer-list audience ships as [[../specs/bianca-full-order-history-customer-list-exclusion-audience]]. |
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
- **The Phase 3 media-buyer dispatch enumerates this table per account** ([[../specs/media-buyer-product-scoped-test-rail]] Phase 3). `runMediaBuyerLoopForAccount` (in [[../libraries/media-buyer-agent]]) reads every active `media_buyer_test_cohorts` row for one `(workspace_id, meta_ad_account_id)`, sorts the `product_id`s (nulls last), and runs `runMediaBuyerLoop` ONCE per row so a shared account carrying Amazing Coffee + Creamer produces two passes (one per `product_id`) — never one shared pass. A dormant (`is_active=false`) row is skipped by the dispatch, and an account with no active row at all still runs a single `productId=null` pass so the audit heartbeat lands.
- **`test_meta_adset_id` is a BARE Meta id (text), not our UUID.** The legacy (shared-adset) gate compares it string-equal to the requested `meta_adset_id`.
- **Per-test cohorts have NO shared adset.** `adset_per_test=true` cohorts mint a fresh $150 adset per creative — `test_meta_adset_id` is NULL. The gate SKIPS the `wrong_adset` identity check and instead enforces: (a) config present (`test_meta_campaign_id` + `adset_template`, else `cohort_misconfigured`), (b) per-adset budget ≤ `per_test_daily_budget_cents` (else `over_ceiling`), (c) concurrency — `(live per-test adsets for the product + 1) × per_test ≤ ceiling` (else `over_concurrency`). The publisher ([[../inngest/ad-tool]] `adToolPublishToMeta`) mints the adset from `ad_publish_jobs.create_adset_spec` with the GATED status (ACTIVE only if allowed) and stamps `meta_adset_id`. Concurrency is bounded twice: deterministically by the replenish deficit (`computeMediaBuyerPlan` target = `maxConcurrentTests`) and independently by the gate's recount at publish. Gated OFF by default — Tabs/Coffee (legacy cohorts) are untouched.
- **`bigint` arrives as a string from PostgREST.** `toCohort` normalizes `daily_test_ceiling_cents` (and `per_test_daily_budget_cents`) to `number` so callers don't have to.

## Migration

- **Phase 1:** `supabase/migrations/20260707120000_media_buyer_test_cohorts.sql` — apply with `npx tsx scripts/apply-media-buyer-test-cohorts-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards, `add column if not exists` on `ad_publish_jobs.origin`). RLS: service-role full access + workspace-member SELECT (mirrors [[ad_spend_budgets]]).
- **Phase 2:** `supabase/migrations/20260707130000_media_buyer_test_cohorts_publish_targets.sql` — additive; adds `default_meta_account_id`, `default_meta_page_id`, `default_meta_instagram_user_id` (all NULLABLE) so the Media Buyer runner can insert replenish `ad_publish_jobs` rows. Apply with `npx tsx scripts/apply-media-buyer-test-cohorts-publish-targets-migration.ts`.
- **[[../specs/media-buyer-sensor-trust-probe]] Phase 1:** `supabase/migrations/20260928130000_media_buyer_test_cohorts_sensor_trust_thresholds.sql` — additive; adds `green_min_coverage`, `yellow_min_coverage`, `max_unresolved_share` (all NULLABLE) so the cohort owner authors the [[media_buyer_sensor_trust]] bands. Apply with `npx tsx scripts/apply-media-buyer-sensor-trust-migration.ts`.
- **[[../specs/media-buyer-product-scoped-test-rail]] Phase 1:** `supabase/migrations/20261015120000_media_buyer_cohort_product.sql` — additive; adds `product_id` (NULLABLE → [[products]].id) so a shared Meta ad account can hold one cohort per product. Replaces the pre-Phase-1 partial unique index on `(workspace_id, meta_ad_account_id)` with `media_buyer_test_cohorts_ws_account_product_active_key` on `(workspace_id, meta_ad_account_id, product_id)` WHERE `is_active`. Fully idempotent (`add column if not exists`, `drop index if exists`, `create unique index if not exists`). Apply with `npx tsx scripts/apply-media-buyer-cohort-product-migration.ts`.
- **Per-test model (foundation):** `supabase/migrations/20261018130000_media_buyer_adset_per_test.sql` — additive; adds `adset_per_test`, `test_meta_campaign_id`, `per_test_daily_budget_cents`, `adset_template` (+ `ad_publish_jobs.create_adset_spec`). Gated OFF by default.
- **Per-test model (nullable adset):** `supabase/migrations/20261019120000_media_buyer_test_adset_nullable.sql` — drops the blanket `test_meta_adset_id NOT NULL` (per-test cohorts have no shared adset) and replaces it with `media_buyer_test_cohorts_adset_shape_chk` (`adset_per_test = true OR test_meta_adset_id IS NOT NULL`) so legacy cohorts still require it. Without this, `provisionProductTestCohort` (which inserts a per-test row with no `test_meta_adset_id`) throws a NOT NULL violation.
- **[[../specs/bianca-cold-test-recent-purchaser-exclusion]] Phase 1:** `supabase/migrations/20261025120000_media_buyer_cohort_excluded_purchaser_audience.sql` — additive; adds `excluded_purchaser_audience_id text?` (NULLABLE) so the cohort can carry the bare Meta customaudience id of the last-180d purchasers exclusion. RLS unchanged. Apply with `npx tsx scripts/apply-media-buyer-cohort-excluded-purchaser-audience-migration.ts`.

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[products]] · [[ad_publish_jobs]] · [[ad_spend_budgets]] · [[iteration_policies]] · [[director_activity]] · [[media_buyer_sensor_trust]] · [[media_buyer_cold_scaler_cohorts]] (SCALER-rail sibling — Bianca M4) · [[../libraries/media-buyer-publish-gate]] · [[../libraries/cold-scaler-cohort]] · [[../lifecycles/ad-publish]] · [[../specs/media-buyer-test-winner-loop]] · [[../specs/media-buyer-sensor-trust-probe]] · [[../specs/media-buyer-product-scoped-test-rail]] · [[../specs/bianca-cold-scaler-cohort-and-daily-ceiling]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
