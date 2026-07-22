# media_buyer_retarget_cohorts

Per-workspace **retarget campaign + consolidated adset + daily-ceiling configuration** for the Media Buyer agent — the RETARGET-rail sibling of [[media_buyer_test_cohorts]] and [[media_buyer_cold_scaler_cohorts]]. One row marks the Meta retarget CAMPAIGN + one consolidated ADSET the Media Buyer's retarget replenish sibling is allowed to publish warm+hot MIXED creatives into, plus a per-day USD ceiling that caps that adset's spend and a whitelist of `audience_temperatures` allowed to publish (defaults to `{warm,hot}`). Introduced by [[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 1 as the foundation for v3 Ad Creative Engine goal M3 (retarget campaign live with warm+hot mixed creative).

**Distinct from** [[media_buyer_test_cohorts]] — that table bounds the TEST rail (cold-only per the shipped [[../specs/bianca-route-ready-creatives-by-dahlia-temperature-tag]]); [[media_buyer_cold_scaler_cohorts]] bounds the cold SCALER rail. This table bounds the RETARGET rail (warm+hot MIXED content into one consolidated retarget adset). The three tables are decoupled so each rail's ceiling, adset, and audience_temperatures move independently — a hard invariant the retarget spec's Phase 2 replenish sibling relies on (Bianca's cold rail must remain cold-scoped).

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); `meta_ad_account_id` AND `product_id` are optional and drive the same three-step precedence as the test-cohort + cold-scaler SDKs:

- `meta_ad_account_id` — `NULL` = the workspace's single-account default; a non-null row scopes the cohort to one connected Meta ad account.
- `product_id` — `NULL` = the (workspace, account) DEFAULT cohort; a non-null row is a per-product cohort in a shared Meta ad account so each product carries its own retarget campaign + ceiling.
- `is_active` — the switch. `false` = dormant (opt-out from the retarget rail), treated identically to "no row" by the SDK. A partial unique index enforces one ACTIVE row per (workspace, meta_ad_account, product) — a shared account can hold both a null-product default AND one row per product simultaneously.

**Owner-editable, service-role-written.** A workspace member can `SELECT` (RLS); writes go through the service role from the (future) retarget admin surface + the [[../libraries/media-buyer-retarget-cohort]] `provisionRetargetCohort` helper, never client-side — mirrors [[media_buyer_test_cohorts]] + [[media_buyer_cold_scaler_cohorts]].

**No seed.** Ships empty — the retarget rail is dormant until the workspace owner opts in by designating a retarget campaign + consolidated adset + ceiling via `provisionRetargetCohort`. The v3 goal M3 explicitly requires this: "the retarget campaign is live with warm+hot mixed creative flowing daily, the CEO can pause it via one kill-switch". No row → the Phase 2 retarget replenish sibling has nothing to publish into and no-ops.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace-wide default; non-null = per-account cohort |
| `product_id` | `uuid?` | → [[products]].id · `NULL` = the (workspace, account) default cohort; non-null = a per-product cohort in a shared Meta ad account so each product gets its own retarget campaign + ceiling |
| `retarget_meta_campaign_id` | `text` | NOT NULL · bare Meta campaign id (client adds no prefix) — the retarget CAMPAIGN. Sibling of `test_meta_campaign_id` on [[media_buyer_test_cohorts]] and `scaler_meta_campaign_id` on [[media_buyer_cold_scaler_cohorts]] |
| `retarget_meta_adset_id` | `text` | NOT NULL · bare Meta ad set id — the SINGLE consolidated retarget adset per the v3 goal design ("one lean campaign, one consolidated adset"). Warm+hot mixed content publishes into this exact adset |
| `daily_ceiling_cents` | `bigint` | NOT NULL · daily USD ceiling in CENTS · `> 0` (CHECK). Bounds the consolidated retarget adset's spend, read by the Phase 2 retarget publish gate |
| `audience_temperatures` | `text[]` | NOT NULL default `'{warm,hot}'` · the whitelist of Dahlia temperatures allowed to publish into this cohort. The Phase 2 replenish sibling filters `listReadyToTest` to this set; a value outside `{warm,hot}` is ignored by the SDK mapper |
| `default_meta_page_id` | `text?` | mirrored from [[../libraries/media-buyer-publish-identity]] `resolvePublishIdentity` at provisioning — the canonical Superfoods Company Facebook Page (never a per-cohort override) |
| `default_meta_instagram_user_id` | `text?` | mirrored from `resolvePublishIdentity` at provisioning — the canonical `@superfoodscompany` Instagram user (never a per-cohort override, per [[../specs/all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram]]) |
| `is_active` | `bool` | NOT NULL default `true` · `false` = dormant (SDK treats as no active cohort) |
| `notes` | `text?` | owner notes — surfaced on the (future) editor |
| `updated_by` | `uuid?` | → `auth.users.id` · ON DELETE SET NULL · `NULL` when a service-role script writes |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `media_buyer_retarget_cohorts_touch_updated_at` trigger |

## Indexes

- `media_buyer_retarget_cohorts_ws_account_product_active_key` — UNIQUE `(workspace_id, coalesce(meta_ad_account_id::text, ''), coalesce(product_id::text, ''))` WHERE `is_active = true`. One active retarget cohort per (workspace, meta_ad_account, product) — same coalesce-to-text shape as the test-cohort + cold-scaler partial indices so null-vs-null uniqueness collapses correctly (Postgres treats null values as distinct in a normal unique index). Flipping `is_active=false` on the current row is the retire path (executed automatically by `provisionRetargetCohort` before inserting the fresh row at the same tuple).

## Triggers

- `media_buyer_retarget_cohorts_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## Precedence at read time

Read the table through the [[../libraries/media-buyer-retarget-cohort]] SDK, NEVER a hand-rolled `.from(...)` (CLAUDE.md § "Raw .from(...) STOP"). The SDK resolves the most-specific row first, then falls back:

1. `(metaAdAccountId, productId)` — a per-product cohort in a shared account.
2. `(metaAdAccountId, product NULL)` — the account default.
3. `(account NULL, product NULL)` — the workspace-wide default (single-account shape).

If none matches → `null`. The consumer treats "no active row" as "retarget surface dormant" — no publish.

## Who writes / reads

- **Writer:** [[../libraries/media-buyer-retarget-cohort]] `provisionRetargetCohort` — the service-role helper the (future) admin surface calls. Idempotent by tuple: retires any prior active row at the same `(workspace, account, product)` before inserting a fresh active row with the canonical publish identity resolved via [[../libraries/media-buyer-publish-identity]] `resolvePublishIdentity`.
- **Reader:** [[../libraries/media-buyer-retarget-cohort]] `getEffectiveRetargetCohort` (precedence) and `listActiveRetargetCohorts` (enumeration). The Phase 2 retarget replenish sibling + retarget publish gate both consume the SDK.

## Gotchas

- **Opt-in — empty table = retarget surface dormant.** A missing row is the DEFAULT — the Phase 2 replenish sibling no-ops. That is the correct behaviour; warm+hot creatives Dahlia tags today have nowhere to flow until the owner provisions a cohort.
- **`is_active=false` is dormant, not deleted.** Retire the current cohort by flipping it to inactive; the audit trail (`updated_by`/`updated_at`) survives. A dormant row is treated identically to "no row" by the SDK.
- **One live cohort at a time (per workspace + account + product).** The partial unique index blocks a second active row for the same scope. `provisionRetargetCohort` retires the current row before inserting so a swap is atomic from the caller's perspective.
- **Per-product row beats null-product account default.** Resolution order: `(account, productId)` → `(account, product NULL)` → `(account NULL, product NULL)`. A caller that omits `productId` still gets the null-product default, so a single-product workspace behaves identically.
- **`retarget_meta_campaign_id` + `retarget_meta_adset_id` are BARE Meta ids (text), not our UUIDs.** Both NOT NULL — Phase 1 does not mint the campaign/adset (unlike `provisionProductTestCohort`); the caller supplies the pair the founder has created via the (later Phase 2/3) admin surface or manually.
- **`bigint` arrives as a string from PostgREST.** The SDK's `toRetargetCohort` mapper normalizes `daily_ceiling_cents` to `number` so callers don't have to.
- **`audience_temperatures` filters at read time in the SDK.** Only `warm` + `hot` are legal; a stray value slipped into the array by a raw insert is silently dropped by `toRetargetCohort`. The Phase 2 replenish sibling uses this whitelist to scope `listReadyToTest`; Bianca's cold rail stays cold-scoped and untouched.
- **`default_meta_page_id` + `default_meta_instagram_user_id` are populated from `resolvePublishIdentity` at provisioning.** Never trust them as an override — the shipped all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram Phase 1 rail already forbids a per-cohort divergence. These columns exist so the retarget admin surface can display the identity a row will publish under.
- **Distinct from the test + cold-scaler rails.** [[media_buyer_test_cohorts]] bounds the TEST ad set's daily budget at PUBLISH time (Media Buyer's autonomous cold-only go-live). [[media_buyer_cold_scaler_cohorts]] bounds the cold SCALER campaign's daily budget. This table bounds the RETARGET adset's daily budget for warm+hot mixed content. Different rails, same precedence pattern, decoupled ceilings.

## Migration

- **[[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 1:** `supabase/migrations/20261127120000_media_buyer_retarget_cohorts.sql` — apply with `npx tsx scripts/apply-media-buyer-retarget-cohorts-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy DO $$ IF NOT EXISTS blocks, `create unique index if not exists`). RLS: service-role full access + workspace-member SELECT (mirrors [[media_buyer_test_cohorts]] + [[media_buyer_cold_scaler_cohorts]]).

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[products]] · [[media_buyer_test_cohorts]] · [[media_buyer_cold_scaler_cohorts]] · [[../libraries/media-buyer-retarget-cohort]] · [[../libraries/media-buyer-publish-identity]] · [[../libraries/media-buyer-publish-gate]] · [[../specs/retarget-campaign-warm-hot-mixed-content]] · [[../specs/bianca-route-ready-creatives-by-dahlia-temperature-tag]] · [[../specs/all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram]] · [[../goals/v3-ad-creative-engine]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
