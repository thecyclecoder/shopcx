# libraries/media-buyer-agent

Media Buyer agent — the weekly Test→Measure→Promote→Kill cadence that the box worker's `media-buyer` lane runs (media-buyer-test-winner-loop Phase 2). Owned by [[../functions/growth]]; supervised by the Growth Director's leash.

**File:** `src/lib/media-buyer/agent.ts` · **Runner:** [[builder-worker]] `runMediaBuyerJob` (scripts/builder-worker.ts).

The Media Buyer is the FIRST autonomous static-ad optimizer in this repo — the mandate's "source → test → scale winners / cut losers → feed learnings back" loop, made continuous and agent-owned. It IS a **supervisable-autonomy tool** ([[../operational-rules]] § North star): it proposes proxy-optimizing actions (scale-up on winners, pause on losers, replenish the test cohort) but every irreversible write goes through EXISTING sanctioned chokepoints:

- **Meta budget/status changes** — the agent writes to [[../tables/iteration_actions]] at `status='decided'`; [[meta__execution]] `executeAutonomousActions` (Storefront Iteration Engine Phase 6a) picks them up and calls the Meta Graph. The agent NEVER calls `updateObjectStatus` / `updateObjectBudget` directly.
- **Live publishes into the test cohort** — the agent inserts [[../tables/ad_publish_jobs]] rows with `origin='media-buyer-test'` + `publish_active=true` and fires `ad-tool/publish-to-meta`. [[media-buyer-publish-gate]] (Phase 1) then decides whether the ad actually ships ACTIVE — a wrong ad set or over-ceiling projection DOWNGRADES + escalates.
- **Every action** stamps one [[../tables/director_activity]] row (`director_function='growth'`) citing the source `meta_ad_id` + realized ROAS + policy version, so the audit trail names the concrete creative, not the wrapper adset.

## The five verbs

Every pass emits at most five kinds of typed action:

- `promote` — a detected winner (via [[winning-creative-detect]] `detectWinners`) whose ROAS ≥ policy `scale_up_roas_trigger` triggers a `scale_up` on the winner's parent Meta adset (via `iteration_actions`). The step is bounded by the policy's `scale_up_step_pct` / `scale_up_cap_pct`. Each action carries the source `meta_ad_id` + its ROAS + the parent `adset_id`.
- `kill` — a decision-tree loser from [[media-buyer__meta-cpa-signal]] `detectMetaCpaLosers` triggers a `pause` (via `iteration_actions`). Phase 2 of [[../specs/media-buyer-kill-on-decision-tree-retire-roas-floor]] pins the kill predicate — `isDecisionTreeKill` in `meta-cpa-signal.ts` — to two sources: **(a)** `tierForTest === 'dud'` (1:1 parity with [[winning-creative-detect|../ads/testing-results-sdk]] `tierForTest`, so an agent kill == a `/ad-testing-results` "dud" badge) — deadline dud (`spend ≥ max_test_spend_cents` AND (`purchases === 0` OR `cac > hold_band_max_cpa_cents`)) OR early dud (`spend ≥ early_trim_min_spend_cents` AND `purchases === 0`) — and **(b)** the EARLY leading-signal trim (cost-per-ATC / CPM / clicks-no-ATC) past `early_trim_min_spend_cents`, gated by the HOLD-band converter guard so a profitable converter (`purchases > 0` AND `cac ≤ hold_band_max_cpa_cents`) is NEVER trimmed. The legacy ROAS-floor / `pause_min_spend_cents` kill trigger is RETIRED (Phase 1); the legacy (S) slow-kill (converter above hold_band, past `crown_min_spend_cents`, pre-deadline) and (F1) 0-purchase-past-`crown_min_spend_cents` backstop are folded into `tierForTest`'s deadline / early-dud rules (Phase 2) — a test with sales, under the deadline, within/near the hold band is NEVER killed (the spec's skeptic v3 protection). The action cites the source `meta_ad_id` so the audit trail names the creative, not just the wrapper.
- `replenish` — when the test cohort ([[../tables/media_buyer_test_cohorts]]) has fewer than `cohortTargetCount` live ads, the agent picks from [[ready-to-test]] (top-of-bin, in ready order) and publishes each via the Phase 1 rail (`origin='media-buyer-test'`, `publish_active=true`). The cohort ceiling is enforced by [[media-buyer-publish-gate]].
- `fatigue_replenish` — **(Phase 3)** — a WINNING ad whose parent adset's `iteration_scorecards_daily.fatigue_score` crosses `FATIGUE_REPLENISH_THRESHOLD = 0.5` (the same cutoff decision-engine uses to suppress a scale-up on fatigue) triggers a call to [[winning-creative-detect]] `amplifyWinner` — spawns N fresh variants of the winning angle at `status='ready'`, respecting the per-day `MAX_AMPLIFICATIONS_PER_DAY` cap. The variants land in [[ready-to-test]] and the standard `replenish` verb picks them up on the next pass to publish into the test cohort. The action cites the source `meta_ad_id` + its ROAS + fatigue score + the resulting `new_ad_campaign_ids` so the lineage is traceable.
- (implicit) `shadow` — **([[../specs/media-buyer-shadow-mode]] Phase 2)** — when the active policy is on `mode='shadow'`, the runner computes the plan (unchanged pure path) but writes ZERO [[../tables/iteration_actions]] + ZERO [[../tables/ad_publish_jobs]] and NEVER calls [[winning-creative-detect]] `amplifyWinner`. Instead, it emits ONE `<verb>_shadow` [[../tables/director_activity]] row per plan action — `media_buyer_promoted_winner_shadow` · `media_buyer_paused_loser_shadow` · `media_buyer_replenished_test_cohort_shadow` · `media_buyer_fatigue_replenish_triggered_shadow` — each carrying `metadata.mode='shadow'` + the full `plan_action` JSON + the source citation (`source_meta_ad_id`, `roas`, `policy_version_id`). The `media_buyer_pass_completed` heartbeat's metadata ALSO carries `mode='shadow'` so a downstream reviewer can filter shadow passes vs armed passes uniformly. The CEO's non-negotiable read-only-before-armed guardrail (parent goal [[../goals/autonomous-media-buyer-supervision]] M2) — a freshly authored policy defaults to `shadow` at author-time, and the flip to `armed` is a separate, audited surface (spec `media-buyer-armed-flip-surface`).
- (implicit) `dormant — no active policy` — no active [[../tables/iteration_policies]] row → NO actions; the pass records `media_buyer_no_active_policy` and returns. Never silent.
- (implicit) `dormant — sensor-trust denied` — **([[../specs/media-buyer-sensor-trust-probe]] Phase 3)** — BEFORE `computeMediaBuyerPlan`, the runner loads the newest [[../tables/media_buyer_sensor_trust]] snapshot for `(workspaceId, metaAdAccountId)` and enforces (a) present, (b) age ≤ `SENSOR_TRUST_MAX_AGE_MS = 48h`, (c) `band !== 'red'`. Any check failing writes ONE `media_buyer_sensor_trust_denied` [[../tables/director_activity]] row (metadata: `{reasons, snapshot_date, band, coverage_ratio}` — the probe's own numbers, cited verbatim) + returns the same dormant summary shape as the no-active-policy path — ZERO `iteration_actions` writes, ZERO `ad_publish_jobs`, no Meta motion. This is the short-circuit the parent goal's "shadow-mode winner/loser calls match a human review within tolerance" criterion hinges on: only trust ROAS numbers once the attribution sensor is provably clean for that cohort. A `stale_snapshot` reason is added when the freshness cap trips (stale trust ≡ untrusted); `missing_snapshot` when the row is absent entirely.

## Exports

### `MediaBuyerPlan` — interface

The typed plan a pass emits. `policyActive`, `policyVersionId`, `cohortConfigured`, `cohortTargetCount`, `currentTestCohortSize`, `promote[]`, `kill[]`, `replenish[]`, `summary`.

### `MediaBuyerPromoteAction` — interface

`{ kind: 'promote', sourceMetaAdId, roas, spendCents, targetLevel, targetObjectId, beforeBudgetCents, afterBudgetCents, rationale, policyVersionId, sourceAdCampaignId }`. The `sourceMetaAdId` + `roas` pair is the spec's verification citation.

### `MediaBuyerKillAction` — interface

`{ kind: 'kill', sourceMetaAdId, roas, spendCents, targetLevel, targetObjectId, rationale, policyVersionId }`.

### `MediaBuyerReplenishAction` — interface

`{ kind: 'replenish', adCampaignId, testMetaAdsetId, dailyTestCeilingCents, rationale }`.

### `MediaBuyerFatigueReplenishAction` — interface

**(Phase 3)** — `{ kind: 'fatigue_replenish', sourceMetaAdId, roas, fatigueScore, variantCount, rationale, policyVersionId, sourceAdCampaignId }`. The runner calls `amplifyWinner` for each and stamps a `media_buyer_fatigue_replenish_triggered` [[../tables/director_activity]] row carrying `{source_meta_ad_id, roas, fatigue_score, variants_spawned, new_ad_campaign_ids}` — the fatigue signal is CITED, not narrated.

### `FATIGUE_REPLENISH_THRESHOLD` / `DEFAULT_FATIGUE_REPLENISH_VARIANTS` — const

`0.5` / `2`. The fatigue cutoff (mirrors decision-engine's `fatigue_score >= 0.5` scale-up suppression) and the default variant count per fatiguing winner. `amplifyWinner` clamps the variant count at `MAX_VARIANTS_PER_WINNER = 4` and enforces the per-day `MAX_AMPLIFICATIONS_PER_DAY = 8` cap.

### `MediaBuyerLoser` — interface

Input row for the plan-computer. `{ sourceMetaAdId, targetLevel, targetObjectId, roas, spendCents, triggeringScorecardId }`. The runner sources these from [[media-buyer__meta-cpa-signal]] `detectMetaCpaLosers` — the crown/kill decision-tree — under the trust-Meta path; a non-trust-Meta policy produces no losers (the legacy ROAS-floor scorecard query is retired per [[../specs/media-buyer-kill-on-decision-tree-retire-roas-floor]] Phase 1).

### `computeMediaBuyerPlan(input: MediaBuyerPlanInputs): MediaBuyerPlan` — function

Pure. Takes fully-hydrated winners + losers + ready-to-test + cohort + policy + budgets, returns the typed plan. Encodes the promote thresholds (`scale_up_roas_trigger`, `scale_up_step_pct`, `scale_up_cap_pct`) and the `never_pause_object_ids` guard on the kill path — the runner does no policy math itself. Post-Phase-1 the pure function TRUSTS its `input.losers` list (already vetted by the decision-tree source) and no longer re-gates on `roas_floor` / `pause_min_spend_cents`.

### `runMediaBuyerLoop(admin, opts): Promise<{ plan, writes }>` — function

The orchestrator. Reads all inputs, computes the plan, persists the writes:

1. `iteration_actions` upsert for promote (scale_up) + kill (pause). Same shape [[../meta/execution]] reads — the executor picks them up next pass.
2. `director_activity` row per plan action + `media_buyer_pass_completed` heartbeat.
3. `ad_publish_jobs` insert per replenish (via the local `enqueueReplenishPublish` helper) + `ad-tool/publish-to-meta` event. Skipped with `media_buyer_replenish_missing_config` if the cohort lacks `default_meta_account_id` / `default_meta_page_id`. **Ad copy is sourced from the campaign's angle** — `enqueueReplenishPublish` loads `product_ad_angles` via `ad_campaigns.angle_id` (the same source the human publish route uses in [[meta__cpa-signal]]) and populates the job's `headlines`/`primary_texts`. **Fail-closed:** the exported pure helper `resolveReplenishAdCopy(angle)` returns `ok:false` when the angle carries no usable `meta_headline`/`meta_primary_text`, and the caller SKIPS the publish with a reason instead of enqueueing an invalid job. This closes the 2026-07-12 defect where the helper hard-coded `headlines:[]`/`primary_texts:[]`, so [[../inngest/ad-tool]] built a Meta creative with empty `asset_feed_spec` `titles[]`/`bodies[]` and Graph rejected EVERY auto-replenish publish with `meta_400 "The link field is required."` (Meta's misleading error for absent ad copy). Unit-pinned in `agent.test.ts` (`resolveReplenishAdCopy` cases).
4. **(Phase 3)** — [[winning-creative-detect]] `amplifyWinner` call per fatigue-replenish action (which fires `ad-tool/generate-full` / `ad-tool/static-requested` for each variant and writes its own `amplified_winner` audit row). The runner also stamps a `media_buyer_fatigue_replenish_triggered` audit row so the FATIGUE-DRIVEN reason (not a manual amplify) is preserved.

Returns `{ plan, writes: { iterationActionsInserted, directorActivityRows, publishJobsInserted, amplifiedAdCampaignIds } }`.

## Sensor-trust contract — dormant without a clean probe

**([[../specs/media-buyer-sensor-trust-probe]] Phase 3.)** The Media Buyer refuses to grade shadow-mode calls against untrusted spend/revenue. Every pass first loads the newest [[../tables/media_buyer_sensor_trust]] row for `(workspaceId, metaAdAccountId)` — ordered `snapshot_date desc, limit 1` — and gates the pass on:

1. **Present** — a null row denies with `reasons=['missing_snapshot']`.
2. **Fresh** — `now - created_at ≤ SENSOR_TRUST_MAX_AGE_MS` (48h), measured from row insertion (not `snapshot_date`, a date bucket) so a day-late probe run doesn't silently keep the pass alive on cold data. Past-cap denies with `stale_snapshot` appended to the probe's own reasons.
3. **Band ≠ 'red'** — a red band is the probe's explicit "sensor untrusted" verdict; the probe's own reasons flow through verbatim on the denial. Yellow is a warning the probe carries via its own reasons (unresolved-share nearing cap, thin spend allocation) — the runner still proceeds; only red short-circuits.

A denial writes ONE `media_buyer_sensor_trust_denied` [[../tables/director_activity]] row + returns the same dormant summary shape the no-active-policy path uses (0 promote/kill/replenish, no writes, `plan.summary` names the denial reason). The row's metadata is `{ meta_ad_account_id, snapshot_date, band, coverage_ratio, reasons, autonomous:true }` — the probe's numbers CITED, not paraphrased. Restore the pass by re-running the [[media-buyer__sensor-trust-probe]] lane (the box worker's `sensor-trust-probe` kind) — a fresh green/yellow snapshot lifts the gate on the next cadence pass.

The pure `evaluateSensorTrustSnapshot` (DB-free) is the seam the unit tests pin the gate math against; the orchestrator's `readLatestSensorTrust` handles the read, and the runner writes the audit row + returns the dormant plan. This mirrors the pure/orchestrator split in [[media-buyer__sensor-trust-probe]] itself so the two libraries stay symmetric.

## Policy contract — dormant without it

The Media Buyer refuses to autonomously act without an active [[../tables/iteration_policies]] row. On a pass with no policy:

- No `iteration_actions` writes.
- No `ad_publish_jobs` inserts.
- One `media_buyer_no_active_policy` [[../tables/director_activity]] row + a dormant summary in `plan.summary`.

The Growth Director (or a human) activates a conservative policy via `scripts/seed-media-buyer-iteration-policy.ts` — that opens the loop. The seed uses [[iteration-policy-authoring]] `authorIterationPolicy` + `activateIterationPolicy` (never raw upsert on `iteration_policies`).

**Conservative seed values** — 1.5× ROAS floor · 3.0× scale trigger · +15% step (cap 25%) · $100 pause min-spend · $10 per-pass account motion ceiling · 24h per-object cooldown.

**Per-cohort calibration** ([[../specs/media-buyer-per-cohort-iteration-policy-calibration]]) replaces the hardcoded 1.5×/3.0× seed with a **data-derived per-cohort proposal**: [[media-buyer-policy-calibrator]] `runMediaBuyerPolicyCalibration` reads each cohort's realized ROAS + spend distribution (30d) + recent account spend (7d) and authors a `pending` [[../tables/iteration_policies]] row at `version = prior_max+1` with a rationale citing every quantile. The runner is gated on a `green` [[../tables/media_buyer_sensor_trust]] snapshot — a `yellow`/`red`/missing snapshot defers via a `media_buyer_calibration_deferred` [[../tables/director_activity]] row (never activates). Activation stays with the Growth Director (via `propose_policy_activation`) — the calibrator NEVER flips `status='active'`. The Growth Director's `buildGrowthDirectorBrief` already surfaces the new pending version under `iterationPolicies` proposals (see [[growth-director]]).

## Test-cohort defaults contract

For the replenish path to actually insert `ad_publish_jobs` rows, the [[../tables/media_buyer_test_cohorts]] row needs its Phase-2 default publish targets set: `default_meta_account_id`, `default_meta_page_id`, `default_meta_instagram_user_id`. Migration `20260707130000_media_buyer_test_cohorts_publish_targets.sql` adds them (all NULLABLE). Without them, replenish is deferred with `media_buyer_replenish_missing_config` — the plan still emits the replenish action, the runner just doesn't fire the publish.

## Callers

- [[builder-worker]] `runMediaBuyerJob` — the box worker's `media-buyer` lane. Fans out over the workspace's connected `meta_ad_accounts` (or one explicit `meta_ad_account_id` in `job.instructions`) and calls `runMediaBuyerLoopForAccount` per account, which itself enumerates the account's active `media_buyer_test_cohorts` rows and dispatches one `runMediaBuyerLoop` pass per active `(account, product)` cohort — a shared account with product A + product B produces TWO passes with distinct `productId`s (Amazing Coffee + Creamer today; [[../specs/media-buyer-product-scoped-test-rail]] Phase 3). A null-product cohort (Superfood Tabs today) produces one pass with `productId=null`; an account with no active cohort still runs ONE dormant pass so the audit heartbeat never silently disappears.

## Gotchas

- **The agent never writes Meta objects directly.** Every mutating call routes through `iteration_actions` → the Phase-6a executor OR through `ad_publish_jobs` → the Phase-1 gate → the publisher. A future adapter that ever calls `updateObjectStatus` / `updateObjectBudget` here breaks the north-star invariant and the box grader will catch it.
- **Loser's `source_meta_ad_id` is best-effort.** The scorecard grain is adset/campaign; the runner joins `meta_ads` in the losing adsets and picks the HIGHEST-SPEND child ad. When no children exist (a wrapped-empty adset), the fallback is the adset id itself. The pause target is unchanged — this is just the audit citation.
- **`per_object_cooldown_hours` is NOT enforced here.** The pause-cooldown is the decision engine's rule; the Media Buyer emits every eligible promote/kill on each pass, and the executor's own idempotency (`onConflict` on `(workspace_id, meta_ad_account_id, object_id, action_type, snapshot_date)`) collapses duplicates within a snapshot. The daily cadence + snapshot key together give a de-facto per-day cooldown.
- **Replenish is capped by BOTH the cohort deficit AND the ready-to-test bin.** A 4-target cohort with 2 live ads and 0 ready-to-test → 0 replenish + a summary flag that the bin is exhausted. That's the correct autonomous behavior — the Growth Director should top up the bin (via [[../inngest/ad-tool]] `ad-tool/generate-full`).
- **The test cohort is PRODUCT-SCOPED** ([[../specs/media-buyer-product-scoped-test-rail]] Phase 2). `DEFAULT_TEST_COHORT_TARGET = 4` — each per-product cohort gets its own 4-live-test target, not one shared across products in the same Meta ad account. The runner reads `cohort.productId` and passes it to BOTH `listReadyToTest` (filters `ad_campaigns.product_id`, so product B's ready creative can never be selected for product A's cohort) AND `readCurrentTestCohortSize`. A null-product default cohort (Superfood Tabs today) omits both filters and preserves the pre-Phase-2 workspace-wide reads.
- **`readCurrentTestCohortSize` counts LIVE campaign adsets, ORIGIN-AGNOSTIC (fixed 2026-07-12).** For a per-test cohort (has `testMetaCampaignId`) it delegates to [[media-buyer-publish-gate]] `countLiveTestAdsetsInCampaign` — counting live `meta_adsets` in the cohort's testing campaign (freed statuses excluded), NOT `ad_publish_jobs`. The old `ad_publish_jobs`-scoped count was blind to adsets minted by the *legacy* loop, so the **Amazing Coffee over-launch** read the current size as 0 (4 pre-existing skeptic adsets, no publish-job rows) → deficit 4-0 → replenished 4 ON TOP → 8 live, double the $600 ceiling. The deficit is `cohortTargetCount − currentTestCohortSize`; an origin-agnostic count makes it impossible to exceed `maxConcurrentTests`. The null-product/legacy path (no campaign) keeps the old `ad_publish_jobs` count so Superfood Tabs is unchanged. The publish-gate ceiling is also product-scoped: `evaluateMediaBuyerTestPublish` accepts a `productId` and routes the cohort resolution to the per-product row, so A's over-ceiling projection is refused while the same amount under B's separate ceiling is allowed in the same account. Phase 3 fans the loop out over every active `(account, product)` cohort.
- **The `(account, product)` fan-out lives in `runMediaBuyerLoopForAccount`** ([[../specs/media-buyer-product-scoped-test-rail]] Phase 3). `RunMediaBuyerOptions` carries `productId`; the box worker's `media-buyer` lane calls `runMediaBuyerLoopForAccount(admin, {workspaceId, metaAdAccountId, cohortTargetCount})` per account, which reads `readActiveCohortProductIds(admin, {workspaceId, metaAdAccountId})` — a sorted, dedup list of the account's active `media_buyer_test_cohorts.product_id` values (null-product last, no active cohort → `[null]`) — and calls `runMediaBuyerLoop({...opts, productId})` per entry. The pre-Phase-2 product-blind `listReadyToTest(admin, { workspaceId })` call is RETIRED from the replenish path — a structural test in [[agent.test.ts]] (`agent.ts — Phase 3 replenish path uses the product-scoped listReadyToTest`) pins the absence; any regression to it fails on the grep guard.
- **Publish-gate re-check is the safety net.** Even though the runner uses `cohort.testMetaAdsetId` as the adset, the publisher runs the Phase-1 gate again on the queued job. A cohort retired between the plan and the publish gets caught + escalated — the ad ships PAUSED.
- **`media_buyer_pass_completed` is ALWAYS emitted.** Even a no-op pass (no winners, no losers, no replenish) writes the heartbeat so the audit trail proves the pass ran. Absence of the row = the lane never fired = investigate the cron/enqueue path.
- **Shadow branch is a return-early carve-out, NOT a code-path fork.** ([[../specs/media-buyer-shadow-mode]] Phase 2.) The runner's shadow branch (`if (policy.mode === "shadow")` right after `computeMediaBuyerPlan`) emits the shadow rows + heartbeat and RETURNS. That preserves the armed executor writes by construction — a stray edit that removes the check would silently start moving budget on a shadow policy, so a small structural test in `agent.test.ts` pins the branch predicate + the pure `buildShadowActivityRows` seam it calls. Never inline the shadow rules into the armed path; keep the carve-out at the top so armed behavior stays untouched.

## Related

[[../tables/media_buyer_test_cohorts]] · [[../tables/media_buyer_sensor_trust]] · [[media-buyer-publish-gate]] · [[media-buyer__sensor-trust-probe]] · [[../tables/ad_publish_jobs]] · [[../tables/ad_campaigns]] · [[../tables/products]] · [[../tables/iteration_policies]] · [[../tables/iteration_actions]] · [[../tables/iteration_scorecards_daily]] · [[../tables/director_activity]] · [[../tables/meta_ads]] · [[winning-creative-detect]] · [[ready-to-test]] · [[../meta/decision-engine]] · [[../meta/execution]] · [[builder-worker]] · [[iteration-policy-authoring]] · [[../specs/media-buyer-test-winner-loop]] · [[../specs/media-buyer-sensor-trust-probe]] · [[../specs/media-buyer-product-scoped-test-rail]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
