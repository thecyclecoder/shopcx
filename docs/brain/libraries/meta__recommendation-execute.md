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
| `new_campaign` | deferred (ship LAST — needs net-new `createCampaign`/`createAdSet` + targeting decisions) |
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

The shipped-and-enabled recommendation types (`new_static_adset`, `new_video_adset`).

### `ENGINE_NAME_TAG` — `"[ie]"`

The stable engine-created marker prepended to every engine-published ad name.

## Callers

- [[meta-performance]] `meta-execute-recommendation` (fired by the review surface
  `/api/ads/iteration-recommendations/[id]` on approve).

## Gotchas

- **Never goes live.** Engine publish jobs are always `publish_active=false`; the
  resulting Meta ad is PAUSED until Dylan flips it live.
- The `[ie]` tag rides on `ad_publish_jobs.ad_name` (the publisher prefers it over
  `ad_campaigns.name`), so the operator's campaign is never renamed.
- Enabling a deferred adapter is a one-line `ENABLED_ADAPTERS` change — but
  `new_campaign`/`test_benefit_angle` first need the adset objective/targeting
  decision (see [[../specs/storefront-iteration-engine]] Phase 6 open questions).

See [[../specs/storefront-iteration-engine]] (Phase 6b) · [[meta__execution]] (6a) ·
[[../lifecycles/ad-publish]] · [[../tables/iteration_recommendations]].
