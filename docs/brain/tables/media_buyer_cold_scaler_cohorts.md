# media_buyer_cold_scaler_cohorts

Per-workspace **cold-scaler campaign + daily-ceiling configuration** for the Media Buyer agent — the SCALER-rail sibling of [[media_buyer_test_cohorts]]. One row marks the Meta scaler CAMPAIGN the Media Buyer is allowed to scale into, plus a per-day USD ceiling that caps that campaign's spend. Introduced by [[../specs/bianca-cold-scaler-cohort-and-daily-ceiling]] as the foundation for Bianca goal M4 (bounded, supervised cold scaler gated on Dahlia winner supply).

**Distinct from [[media_buyer_test_cohorts]]** — the test cohort bounds the TEST rail ($600/day today); this table bounds the SCALER rail. Decoupled so the two ceilings move independently. The arming gate, CAC:LTV sensor, and graduate-crowned-winners specs (Bianca M4 follow-ons) all read THIS table to know whether the scaler exists, what its ceiling is, and whether it is active.

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); `meta_ad_account_id` AND `product_id` are optional and drive the same three-step precedence as the test-cohort SDK:

- `meta_ad_account_id` — `NULL` = the workspace's single-account default; a non-null row scopes the cohort to one connected Meta ad account.
- `product_id` — `NULL` = the (workspace, account) DEFAULT cohort; a non-null row is a per-product cohort in a shared Meta ad account so each product carries its own scaler campaign + ceiling.
- `is_active` — the switch. `false` = dormant (opt-out from the scaler rail), treated identically to "no row" by the SDK. A partial unique index enforces one ACTIVE row per (workspace, meta_ad_account, product) — a shared account can hold both a null-product default AND one row per product simultaneously.

**Owner-editable, service-role-written.** A workspace member can `SELECT` (RLS); writes go through the service role from the (future) Media Buyer admin surface, never client-side — mirrors [[media_buyer_test_cohorts]].

**No seed.** Ships empty — the scaler rail is dormant until the workspace owner opts in by designating a scaler campaign + ceiling. Bianca goal M4 explicitly requires this: "a bounded, supervised cold scaler gated on Dahlia winner supply". No row → the arming gate refuses, the CAC:LTV sensor has nothing to gate on, and the graduate spec has no target campaign.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace-wide default; non-null = per-account cohort |
| `product_id` | `uuid?` | → [[products]].id · `NULL` = the (workspace, account) default cohort; non-null = a per-product cohort in a shared Meta ad account so each product gets its own scaler campaign + ceiling |
| `scaler_meta_campaign_id` | `text?` | bare Meta campaign id (client adds no prefix) — the cold-scaler CAMPAIGN. NULLABLE until a scaler campaign is minted (Bianca M4 follow-on spec). Sibling of `test_meta_campaign_id` on [[media_buyer_test_cohorts]] |
| `daily_scaler_ceiling_cents` | `bigint` | NOT NULL · daily USD ceiling in CENTS · `> 0` (CHECK). The whole-cohort scaler ceiling read by the arming gate + CAC:LTV sensor |
| `is_active` | `bool` | NOT NULL default `true` · `false` = dormant (SDK treats as no active cohort) |
| `notes` | `text?` | owner notes — surfaced on the (future) editor |
| `updated_by` | `uuid?` | → `auth.users.id` · ON DELETE SET NULL · `NULL` when a service-role script writes |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `media_buyer_cold_scaler_cohorts_touch_updated_at` trigger |

## Indexes

- `media_buyer_cold_scaler_cohorts_ws_account_product_active_key` — UNIQUE `(workspace_id, coalesce(meta_ad_account_id::text, ''), coalesce(product_id::text, ''))` WHERE `is_active = true`. One active scaler cohort per (workspace, meta_ad_account, product) — same coalesce-to-text shape as the test-cohort partial index so null-vs-null uniqueness collapses correctly (Postgres treats null values as distinct in a normal unique index). Flipping `is_active=false` on the current row is the retire path.

## Triggers

- `media_buyer_cold_scaler_cohorts_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## Precedence at read time

Read the table through the [[../libraries/cold-scaler-cohort]] SDK, NEVER a hand-rolled `.from(...)` (CLAUDE.md § "Raw .from(...) STOP"). The SDK resolves the most-specific row first, then falls back:

1. `(metaAdAccountId, productId)` — a per-product cohort in a shared account (Coffee vs Creamer).
2. `(metaAdAccountId, product NULL)` — the account default.
3. `(account NULL, product NULL)` — the workspace-wide default (single-account shape).

If none matches → `null`. The consumer treats "no active row" as "scaler surface dormant" — no spend, arming gate refuses.

## Who writes / reads

- **Writer:** a one-off `INSERT` from the owner today; a future Media Buyer admin surface will upsert through a service-role API. Never client-side.
- **Reader:** [[../libraries/cold-scaler-cohort]] `getEffectiveMediaBuyerColdScalerCohort` (precedence) and `listActiveColdScalerCohorts` (enumeration). The Bianca M4 follow-on specs — arming gate, CAC:LTV sensor, graduate-crowned-winners — all consume the SDK.

## Gotchas

- **Opt-in — empty table = scaler surface dormant.** A missing row is the DEFAULT — the arming gate refuses to arm a scaler pass. That is the correct behaviour; the Media Buyer never scales until the owner designates a scaler cohort.
- **`is_active=false` is dormant, not deleted.** Retire the current cohort by flipping it to inactive; the audit trail (`updated_by`/`updated_at`) survives. A dormant row is treated identically to "no row" by the SDK.
- **One live cohort at a time (per workspace + account + product).** The partial unique index blocks a second active row for the same scope. To swap cohorts, retire the current one first (or wrap the swap in a transaction).
- **Per-product row beats null-product account default.** Resolution order: `(account, productId)` → `(account, product NULL)` → `(account NULL, product NULL)`. A caller that omits `productId` still gets the null-product default, so a single-product workspace behaves identically.
- **`scaler_meta_campaign_id` is a BARE Meta id (text), not our UUID.** NULLABLE — a cohort can exist before the scaler campaign is minted (the follow-on graduate spec fills it in).
- **`bigint` arrives as a string from PostgREST.** The SDK's `toColdScalerCohort` mapper normalizes `daily_scaler_ceiling_cents` to `number` so callers don't have to.
- **Distinct from the test rail.** [[media_buyer_test_cohorts]] bounds the TEST ad set's daily budget at PUBLISH time (Media Buyer's autonomous go-live). This table bounds the SCALER campaign's daily budget for the M4 scaler rail. Different altitudes; do not conflate.

## Migration

- **[[../specs/bianca-cold-scaler-cohort-and-daily-ceiling]] Phase 1:** `supabase/migrations/20261022120000_media_buyer_cold_scaler_cohorts.sql` — apply with `npx tsx scripts/apply-media-buyer-cold-scaler-cohorts-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy DO $$ IF NOT EXISTS blocks, `create unique index if not exists`). RLS: service-role full access + workspace-member SELECT (mirrors [[media_buyer_test_cohorts]]).

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[products]] · [[media_buyer_test_cohorts]] · [[media_buyer_cold_scaler_arming_authorization]] · [[../libraries/cold-scaler-cohort]] · [[../libraries/media-buyer__cold-scaler-arming-gate]] · [[../libraries/media-buyer-publish-gate]] · [[../specs/bianca-cold-scaler-cohort-and-daily-ceiling]] · [[../specs/bianca-cold-scaler-arming-gate-shadow-to-armed]] · [[../goals/bianca-temperature-aware-campaign-structure]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
