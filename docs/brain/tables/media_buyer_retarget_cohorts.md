# media_buyer_retarget_cohorts

Per-workspace **retarget-campaign configuration** for the Media Buyer agent — the CONTROLLED autonomous go-live rail behind [[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 1. One row marks the Media Buyer's THIRD Meta campaign: a dedicated **retarget campaign** with ONE lean **consolidated ad set** carrying **WARM + HOT MIXED** creative (sourced from creatives Dahlia tags `warm`/`hot`), plus a per-day USD ceiling capping that adset's spend.

**Distinct from [[media_buyer_test_cohorts]]** (the COLD test rail behind Bianca's replenish loop): that table stands up per-test $150 COLD ad sets under a testing campaign; THIS table stands up ONE consolidated adset under a retarget campaign carrying the warm+hot mix. The two rails never contend for a creative — the retarget rail reads its own `audience_temperatures` whitelist (default `{warm,hot}`) and NEVER touches the cold-only invariant of the test loop.

The retarget publish path ([[../libraries/media-buyer-retarget-cohort]] `getEffectiveRetargetCohort` → [[../libraries/media-buyer-retarget-publish-gate]] `evaluateMediaBuyerRetargetPublish`) reads this table on any job flagged `origin='media-buyer-retarget'`. A wrong adset, an over-ceiling projection, OR a below-floor Max copy-QC verdict REFUSES the live flag — the ad publishes PAUSED and the gate writes a growth-owned `director_activity` escalation (`action_kind='media_buyer_retarget_publish_refused'`) per [[../operational-rules]] § North star (hit a rail = escalate, not execute).

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); `meta_ad_account_id` AND `product_id` are optional and resolve most-specific-first (product-exact → account null-product default → workspace-wide null-account default), identical to [[media_buyer_test_cohorts]]. `is_active` is the switch; a partial unique index enforces one ACTIVE row per (workspace, meta_ad_account, product).

**Owner-editable, service-role-written.** A workspace member can `SELECT` (RLS); writes go through the service role via [[../libraries/media-buyer-retarget-cohort]] `provisionRetargetCohort`, never client-side.

**No seed.** Ships empty — the retarget go-live is dormant until the workspace owner designates a retarget campaign + consolidated adset + ceiling.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace-wide default; non-null = per-account cohort |
| `product_id` | `uuid?` | → [[products]].id · `NULL` = the (workspace, account) default retarget cohort; non-null = per-product cohort in a shared account |
| `retarget_meta_campaign_id` | `text` | NOT NULL · bare Meta campaign id of the dedicated retarget campaign the consolidated adset lives under |
| `retarget_meta_adset_id` | `text` | NOT NULL · bare Meta ad-set id of the ONE consolidated retarget adset every warm/hot creative publishes into |
| `daily_ceiling_cents` | `bigint` | NOT NULL · daily USD ceiling in CENTS · `> 0` · caps the consolidated adset's spend |
| `audience_temperatures` | `text[]` | NOT NULL default `'{warm,hot}'` · the warm/hot MIX this rail carries. Fed to [[../libraries/ready-to-test]] `listReadyToTest`'s temperature WHITELIST so ONE read surfaces both bands. |
| `is_active` | `bool` | NOT NULL default `true` · `false` = dormant (gate treats as no active cohort) |
| `notes` | `text?` | owner notes |
| `updated_by` | `uuid?` | → `auth.users.id` · ON DELETE SET NULL · `NULL` when a service-role script writes |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `media_buyer_retarget_cohorts_touch_updated_at` trigger |

## Indexes

- `media_buyer_retarget_cohorts_ws_account_product_active_key` — UNIQUE `(workspace_id, coalesce(meta_ad_account_id::text, ''), coalesce(product_id::text, ''))` WHERE `is_active = true`. One active retarget cohort per (workspace, meta_ad_account, product); flipping `is_active=false` is the retire path.

## Triggers

- `media_buyer_retarget_cohorts_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## Who writes / reads

- **Writer:** [[../libraries/media-buyer-retarget-cohort]] `provisionRetargetCohort` (service role) — idempotent upsert on (workspace, account, product); retires the prior active row then inserts fresh.
- **Reader:** [[../libraries/media-buyer-retarget-cohort]] `getEffectiveRetargetCohort` (on every retarget replenish pass + the retarget publish gate), driven daily by [[../inngest/media-buyer-retarget-cadence]].

## Gotchas

- **Opt-in — empty table = no autonomous retarget go-live.** A missing row is the DEFAULT; the gate REFUSES with `no_active_retarget_cohort` + escalation.
- **`is_active=false` is dormant, not deleted.** The audit trail (`updated_by`/`updated_at`) survives.
- **ONE consolidated adset — not per-test.** Unlike [[media_buyer_test_cohorts]] (which mints a fresh $150 adset per creative), the retarget rail publishes EVERY warm/hot creative into the single `retarget_meta_adset_id`.
- **Never touches the cold rail.** The retarget loop reads only this table + warm/hot creatives; Bianca's cold replenish (`temperature: "cold"` in [[../libraries/media-buyer-agent]]) is byte-unchanged.
- **`bigint` arrives as a string from PostgREST.** The SDK's `toCohort` normalizes `daily_ceiling_cents` to `number`.

## Migration

- **[[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 1:** `supabase/migrations/20261127120000_media_buyer_retarget_cohorts.sql` — `create table if not exists`, touch-`updated_at` trigger, partial unique index, RLS enabled + service-role FOR ALL + workspace-member SELECT policies (mirrors [[media_buyer_test_cohorts]]).

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[products]] · [[ad_publish_jobs]] · [[media_buyer_test_cohorts]] · [[../libraries/media-buyer-retarget-cohort]] · [[../libraries/media-buyer-retarget-publish-gate]] · [[../libraries/media-buyer-retarget-agent]] · [[../inngest/media-buyer-retarget-cadence]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
