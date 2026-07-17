# libraries/media-buyer-publish-gate

Media Buyer publish gate — the CONTROLLED autonomous go-live rail on the current PAUSED-only Meta publisher ([[../lifecycles/ad-publish]]). Reads the workspace's [[../tables/media_buyer_test_cohorts]] row on a `origin='media-buyer-test'` publish and either ALLOWS the live flag (adset match + under-ceiling) or REFUSES it — PAUSED + escalate. Authored by [[../specs/media-buyer-test-winner-loop]] (Phase 1).

**File:** `src/lib/media-buyer/publish-gate.ts`

**Callers:** the publish route ([[../lifecycles/ad-publish]] step 3 — `POST /api/ads/campaigns/[id]/publish`) and the publisher's belt-and-suspenders re-check ([[../inngest/ad-tool]] `adToolPublishToMeta` before `createAd`). Same helper in both places; the route catches the request at insert time; the publisher catches a stale cohort or a route-bypassing script.

**Distinct from** [[ad-spend-governor]] — this gate is evaluated at PUBLISH time on ONE ad set's ABSOLUTE daily budget; ad-spend-governor is evaluated on CADENCE across ROLLING WINDOWS of actual spend. Different altitudes, different tables (`media_buyer_test_cohorts` vs `ad_spend_budgets`), different rails.

## Exports

### `MEDIA_BUYER_TEST_ORIGIN` — const

`"media-buyer-test"` — the `ad_publish_jobs.origin` sentinel that opts INTO this gate. Non-media-buyer origins skip the gate entirely.

### `MediaBuyerTestCohort` — interface

TS shape of a [[../tables/media_buyer_test_cohorts]] row (`snake → camel`; `bigint` `daily_test_ceiling_cents` normalized to `number`).

### `getEffectiveMediaBuyerTestCohort` — function

```ts
async function getEffectiveMediaBuyerTestCohort(
  admin: Admin,
  workspaceId: string,
  args: { metaAdAccountId?: string | null },
): Promise<MediaBuyerTestCohort | null>
```

The MORE-SPECIFIC active row wins: a per-account row (`meta_ad_account_id` set) beats the workspace-wide row (`meta_ad_account_id IS NULL`) for the same workspace. Only considers `is_active=true` rows. Returns `null` when no active cohort exists — the caller then refuses with `reason='no_active_cohort'`.

### `MediaBuyerTestRefusalReason` — type

`"no_active_cohort" | "wrong_adset" | "over_ceiling" | "over_concurrency" | "cohort_misconfigured" | "missing_purchaser_exclusion"` — why the gate refused a media-buyer-test publish. Carried on the escalation body + the growth `director_activity` metadata + the dedupe key. The last three are **per-test-cohort only** (`adset_per_test=true`): `over_concurrency` = minting another $150 adset would push live tests × per-test over the ceiling; `cohort_misconfigured` = per-test cohort missing `test_meta_campaign_id`/`adset_template`; `missing_purchaser_exclusion` = the cohort declares `excluded_purchaser_audience_id` but the proposed adset targeting does NOT list that id under `excluded_custom_audiences` ([[../specs/bianca-cold-test-recent-purchaser-exclusion]] Phase 3, defends the M2 cold-read hygiene lever).

### `MediaBuyerTestGateInput` — interface

`{ workspaceId, metaAdAccountId, metaAdsetId, projectedDailyCents, targeting?, createAdsetSpec? }` — one publish request's ask. `projectedDailyCents` is the daily budget in cents the ad set WILL carry after this publish (Meta ABO: the ad-set carries the daily_budget, not the ad). `targeting`/`createAdsetSpec` are the proposed adset spec ([[../specs/bianca-cold-test-recent-purchaser-exclusion]] Phase 3): the per-test path passes `createAdsetSpec` (the `ad_publish_jobs.create_adset_spec` shape) and the gate inspects `createAdsetSpec.targeting.excluded_custom_audiences`; a direct/legacy path may pass `targeting` instead. Omitting both is treated as an empty targeting spec — a cohort that declares `excluded_purchaser_audience_id` will refuse `missing_purchaser_exclusion` when the caller can't prove the exclusion is present.

### `MediaBuyerTestGateResult` — union

`{ allowed: true, cohort, projectedDailyCents, ceilingCents }` on success; `{ allowed: false, reason, cohort, projectedDailyCents, ceilingCents, diagnosis }` on refusal. `diagnosis` is human copy the escalation surfaces to the CEO.

### `evaluateMediaBuyerTestPublish` — function

```ts
async function evaluateMediaBuyerTestPublish(
  admin: Admin,
  input: MediaBuyerTestGateInput,
): Promise<MediaBuyerTestGateResult>
```

The gate. Loads the effective cohort, then branches on the cohort shape:
- **Legacy (`adset_per_test=false`):** no active cohort → `no_active_cohort`; requested adset != cohort adset → `wrong_adset`; projected daily > ceiling → `over_ceiling`; else allow.
- **Per-test (`adset_per_test=true`, CEO 2026-07-12):** no shared adset exists — the `wrong_adset` identity check is SKIPPED. Instead: missing `test_meta_campaign_id`/`adset_template` → `cohort_misconfigured`; per-adset budget > `per_test_daily_budget_cents` → `over_ceiling`; `(live per-test adsets + 1) × per_test > ceiling` → `over_concurrency`; cohort declares `excluded_purchaser_audience_id` but the proposed adset targeting does NOT list that id under `excluded_custom_audiences` → `missing_purchaser_exclusion` ([[../specs/bianca-cold-test-recent-purchaser-exclusion]] Phase 3); else allow. The deterministic primary cap is the replenish deficit (`computeMediaBuyerPlan` target = `maxConcurrentTests`); this gate is the independent recount at publish time.
  - **Concurrency count is ORIGIN-AGNOSTIC (`countLiveTestAdsetsInCampaign`, shared with [[media-buyer-agent]] `readCurrentTestCohortSize`).** It counts the **live `meta_adsets` in the cohort's `test_meta_campaign_id`** (each per-test cohort's testing campaign is product-specific, so campaign scope == product scope), excluding `FREED_ADSET_STATUSES` (PAUSED/ADSET_PAUSED/CAMPAIGN_PAUSED/ARCHIVED/DELETED). **Why not `ad_publish_jobs`:** the old count only saw adsets the *new* per-test publisher minted, so it was blind to adsets from the *legacy* media-buyer loop — the **2026-07-12 Amazing Coffee over-launch**: the count read 0 (the 4 pre-existing skeptic adsets had no publish-job rows), deficit read 4-0, and it replenished 4 fresh ON TOP → 8 live, double the $600 ceiling. Counting live campaign adsets makes "> maxConcurrent" structurally impossible regardless of who minted the adset. Pausing a dud FREES its slot for the next replenish.

NEVER escalates — the caller runs `escalateMediaBuyerTestPublishRefusal` on refusal so the audit trail records WHO caught the rail (the route vs the publisher's defensive re-check).

### `escalateMediaBuyerTestPublishRefusal` — function

```ts
async function escalateMediaBuyerTestPublishRefusal(
  admin: Admin,
  args: { workspaceId, metaAdsetId, metaAdAccountId, projectedDailyCents, reason,
          diagnosis, ceilingCents, jobId?, campaignId? },
): Promise<{ emitted: boolean }>
```

Emits ONE CEO Approval Request via [[platform-director]] `escalateDiagnosisToCeo` (`escalationKind='media_buyer_test_gate_refused'`, deep-link `/dashboard/marketing/ads`) + ONE growth-owned [[../tables/director_activity]] row (`director_function='growth'`, `action_kind='media_buyer_test_gate_refused'`, metadata carries `{origin, reason, meta_adset_id, meta_ad_account_id, projected_daily_cents, ceiling_cents, job_id, campaign_id, dedupe_key}`). Deduped by `escalateDiagnosisToCeo`'s notification check on the dedupe key so one OPEN escalation exists per `(workspace, adset, reason)` — a route-caught refusal doesn't fan out a duplicate when the publisher's re-check hits the same rail.

## The three refusal branches (Phase 1 verification)

The spec calls out three cases; the gate returns each explicitly + the caller handles them uniformly (`publish_active=false` + escalation):

1. **in-adset + under-cap → ALLOW** — the publish sets `publish_active=true` and the route separately pins the ad-set's `daily_budget` to the ceiling via [[meta-ads]] `updateObjectBudget`.
2. **wrong-adset → REFUSE (`wrong_adset`)** — the requested `meta_adset_id` != cohort `test_meta_adset_id`. Publish PAUSED, escalate.
3. **over-cap → REFUSE (`over_ceiling`)** — projected daily > cohort ceiling. Publish PAUSED, escalate.

A fourth `no_active_cohort` refusal (the workspace hasn't opted in) is treated identically to the two named refusals — PAUSED + escalate — so a media-buyer-test publish can NEVER slip past unconfigured state.

## Callers

- `POST /api/ads/campaigns/[id]/publish` — evaluates the gate BEFORE inserting the [[../tables/ad_publish_jobs]] row, sets `publish_active` accordingly, escalates on refusal, and (on allow) pins the ad-set's daily budget to the ceiling via [[meta-ads]] `updateObjectBudget` so the ad-set can't spend past the cap.
- [[../inngest/ad-tool]] `adToolPublishToMeta` — RE-CHECKS the gate on the loaded job just before `createAd`. On refusal it DOWNGRADES `publish_active=false` (writes the change back to `ad_publish_jobs`) and escalates. This catches a route-bypass (an ad-hoc script fires `ad-tool/publish-to-meta` directly) or a cohort retired between insert and publish.

## Gotchas

- **A surfaced guardrail, NEVER a kill-switch.** The gate only downgrades LIVE → PAUSED and escalates. It NEVER cancels the publish, deletes the ad, or throttles an existing ACTIVE ad. The autonomous go-live is CONTROLLED; the CEO decides the response ([[../operational-rules]] § North star).
- **Non-media-buyer origins skip.** A studio/operator publish or a `null` origin bypasses the gate entirely — the current studio path is unchanged.
- **`no_active_cohort` is intentional friction.** An unconfigured workspace can't autonomously go-live; the first Media Buyer publish surfaces the "designate a test cohort" ask to the CEO instead of silently PAUSING with no diagnosis.
- **Dedup is per (workspace, adset, reason).** A refusal that swaps between `wrong_adset` and `over_ceiling` re-escalates (different dedupe keys). A repeat of the SAME refusal on the same adset dedupes into the existing open notification.
- **Belt-and-suspenders is idempotent-safe.** The route's escalation + the publisher's escalation on the same job share the same dedupe key. Only the first one that lands writes a notification; the second short-circuits (still updates the audit ledger only if the notification actually landed).

## Related

[[../tables/media_buyer_test_cohorts]] · [[../tables/ad_publish_jobs]] · [[../tables/director_activity]] · [[../tables/dashboard_notifications]] · [[meta-ads]] · [[ad-spend-governor]] · [[platform-director]] · [[../inngest/ad-tool]] · [[../lifecycles/ad-publish]] · [[../specs/media-buyer-test-winner-loop]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
