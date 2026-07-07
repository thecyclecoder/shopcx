# libraries/meta/recommendation-execute

Approval-gated execution adapters — Storefront Iteration Engine **Phase 6b**. When
Dylan approves an [[../tables/iteration_recommendations]] row (status pending →
approved), this dispatcher turns it into a real but **DRAFT/PAUSED** Meta object.
A new live spend line is **never** set live automatically.

**File:** `src/lib/meta/recommendation-execute.ts`

## What it does

Dispatches by `action_type`:

| `action_type` | adapter |
|---|---|
| `new_static_adset` / `new_video_adset` | **enabled** — reuse the native publish path: create an [[../tables/ad_publish_jobs]] row (`publish_active=false` → PAUSED, tagged `[ie]` via `ad_name`, linked via `recommendation_id`) and fire `ad-tool/publish-to-meta` ([[../inngest/ad-tool]]), which uploads the built creative + creates the ad PAUSED in the target adset |
| `new_campaign` | **enabled** (media-buyer loop, meta-campaign-adset-creation-primitive Phase 2 + Phase 3) — get-or-create the shared `MB — Testing (ABO)` campaign via `getOrCreateTestingCampaign` and create one PAUSED purchase-optimized ad set via `createAdSet` ([[meta-ads]]) with ad-set-level `daily_budget`, `optimization_goal=OFFSITE_CONVERSIONS`, `bid_strategy=LOWEST_COST_WITHOUT_CAP`, `promoted_object={pixel_id,custom_event_type:"PURCHASE"}`, Advantage+ placements. **Governed** by [[ad-spend-governor]]: a proposed daily × `windowDays` that would push the account's rolling spend past its `ad_spend_budgets` ceiling ESCALATES (growth `director_activity` `escalated_new_adset_over_ceiling` + `external_result.deferred='governor_ceiling_breach'`) instead of creating a live object. Every successful create stamps a growth `director_activity` `created_test_adset` for Max's audit AND `reconcileCreatedAdSetToMirror` upserts the new campaign + ad set into [[../tables/meta_campaigns]] + [[../tables/meta_adsets]] so the attribution engine ([[../tables/meta_attribution_daily]]) and winner-detector resolve the object immediately, without waiting for the next `syncMetaStructure` cycle. When `params.ad_campaign_id` is set, chains straight into the publish adapter so the concept's ad lands PAUSED inside the new ad set. |
| `test_benefit_angle` | deferred (seed `ad_campaigns` + `ad-tool/generate-full`, then publish) |
| `new_lander_variant` | deferred (`generateAdvertorialPagesForCampaign`) |
| `offer_test` | deferred (a pricing/offer change, not an ad publish) |

A deferred type is left `status='approved'` with `external_result.deferred` set
(a reason), so nothing is lost and the rollout is legible.

The enabled publish adapter requires concrete build inputs in the recommendation's
`params`: `ad_campaign_id` (a built [[../tables/ad_campaigns]] with ready media),
`meta_adset_id` (existing target adset), `meta_page_id`, `destination_url`
(optional: `meta_instagram_user_id`, `video_id`, `headlines`, `primary_texts`,
`description`, `cta_type`). Missing required inputs ⇒ deferred
(`external_result.deferred='missing_build_inputs:…'`) — never guessed.

## Write-back / idempotency

- On dispatch the dispatcher records `external_result.ad_publish_job_id` immediately
  and short-circuits an already-dispatched row (`already_dispatched`); only
  `status='approved'` rows execute.
- The publisher ([[../inngest/ad-tool]] `ad-tool-publish-to-meta`) writes the engine
  `meta_ad_id`/`meta_creative_id`/`meta_video_id` back to the recommendation and
  flips `status='executed'` on success (or `status='failed'`), keyed on the job's
  `recommendation_id`.

## Exports

### `executeRecommendation` — function

```ts
async function executeRecommendation(workspaceId: string, recommendationId: string): Promise<ExecuteRecommendationResult>
```
Returns `{ status: 'executed'|'deferred'|'failed'|'skipped', reason?, ad_publish_job_id? }`.
Safe to call more than once (non-approved / already-dispatched rows short-circuit).

### `ENABLED_ADAPTERS` — `ReadonlySet<RecommendationType>`

The shipped-and-enabled recommendation types (`new_static_adset`, `new_video_adset`, `new_campaign`).

### `ENGINE_NAME_TAG` — `"[ie]"`

The stable engine-created marker prepended to every engine-published ad name.

### `evaluateGovernorHeadroom(budget, actualCents, proposedDailyBudgetCents)` — pure function

The "test-ceiling" predicate. Projects `actualCents + proposedDailyBudgetCents × budget.windowDays` against `budget.usdCeilingCents`; returns `{ ok: true }` when the projection fits under the ceiling, `{ ok: false, reason }` when the caller must escalate. A `null` budget = `ok:true` (no ceiling configured — nothing to enforce). Called by the `new_campaign` adapter; kept pure so a media-buyer dry-run can simulate it without a live Graph call.

### `reconcileCreatedAdSetToMirror(admin, input)` — Phase 3 mirror seed

Upserts the just-created campaign + ad set into `meta_campaigns` + `meta_adsets` on the SAME natural keys `syncMetaStructure` uses (`workspace_id,meta_campaign_id` and `workspace_id,meta_adset_id`), so the local mirror is immediately consistent — the attribution engine and winner-detector don't have to wait for the next cron cycle to see the new object. A supabase error THROWS (a swallowed upsert would leave the mirror silently stale — the failure mode `performance.ts::upsertOrThrow` was written to prevent). The next real sync overwrites the seeded row cleanly on the same natural key. `input` = `{ workspaceId, metaAdAccountId (uuid), metaCampaignId, campaignName, campaignObjective, metaAdsetId, adsetName, optimizationGoal, dailyBudgetCents, status, syncedAt }`.

## Callers

- [[meta-performance]] `meta-execute-recommendation` (fired by the review surface
  `/api/ads/iteration-recommendations/[id]` on approve).

## Gotchas

- **Never goes live.** Engine publish jobs are always `publish_active=false`; the
  resulting Meta ad is PAUSED until Dylan flips it live.
- The `[ie]` tag rides on `ad_publish_jobs.ad_name` (the publisher prefers it over
  `ad_campaigns.name`), so the operator's campaign is never renamed.
- Enabling a deferred adapter is a one-line `ENABLED_ADAPTERS` change — `test_benefit_angle`/`new_lander_variant`/`offer_test` still need their build paths (see [[../specs/storefront-iteration-engine]] Phase 6 open questions).
- **Guarded compare-and-set on every `iteration_recommendations` update.** `updateRecommendationGuarded` narrows every post-async write to `(.eq id .eq workspace_id .eq status='approved').select('id')`; the callers bail on `changed=false` so a stale read cannot overwrite a rec that was flipped mid-flight. This is the "prove the guard before the mutation fires" rule from the coaching.
- **Governor is a hard rail, not advisory.** On breach the `new_campaign` adapter escalates and returns `deferred:'governor_ceiling_breach'` — it does NOT create a PAUSED-but-recoverable object either. The `director_activity` row records the projection numbers so the CEO can raise the ceiling and re-approve. Same north-star pattern as [[ad-spend-governor]].

See [[../specs/storefront-iteration-engine]] (Phase 6b) · [[../specs/meta-campaign-adset-creation-primitive]] (Phase 2) · [[meta-ads]] (`createCampaign`/`createAdSet`/`getOrCreateTestingCampaign`) · [[ad-spend-governor]] · [[director-activity]] · [[meta__execution]] (6a) · [[../lifecycles/ad-publish]] · [[../tables/iteration_recommendations]].
