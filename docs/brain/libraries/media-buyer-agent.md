# libraries/media-buyer-agent

Media Buyer agent — the weekly Test→Measure→Promote→Kill cadence that the box worker's `media-buyer` lane runs (media-buyer-test-winner-loop Phase 2). Owned by [[../functions/growth]]; supervised by the Growth Director's leash.

**File:** `src/lib/media-buyer/agent.ts` · **Runner:** [[builder-worker]] `runMediaBuyerJob` (scripts/builder-worker.ts).

The Media Buyer is the FIRST autonomous static-ad optimizer in this repo — the mandate's "source → test → scale winners / cut losers → feed learnings back" loop, made continuous and agent-owned. It IS a **supervisable-autonomy tool** ([[../operational-rules]] § North star): it proposes proxy-optimizing actions (scale-up on winners, pause on losers, replenish the test cohort) but every irreversible write goes through EXISTING sanctioned chokepoints:

- **Meta budget/status changes** — the agent writes to [[../tables/iteration_actions]] at `status='decided'`; [[meta__execution]] `executeAutonomousActions` (Storefront Iteration Engine Phase 6a) picks them up and calls the Meta Graph. The agent NEVER calls `updateObjectStatus` / `updateObjectBudget` directly.
- **Live publishes into the test cohort** — the agent inserts [[../tables/ad_publish_jobs]] rows with `origin='media-buyer-test'` + `publish_active=true` and fires `ad-tool/publish-to-meta`. [[media-buyer-publish-gate]] (Phase 1) then decides whether the ad actually ships ACTIVE — a wrong ad set or over-ceiling projection DOWNGRADES + escalates.
- **Every action** stamps one [[../tables/director_activity]] row (`director_function='growth'`) citing the source `meta_ad_id` + realized ROAS + policy version, so the audit trail names the concrete creative, not the wrapper adset.

## The four verbs

Every pass emits at most four kinds of typed action:

- `promote` — a detected winner (via [[winning-creative-detect]] `detectWinners`) whose ROAS ≥ policy `scale_up_roas_trigger` triggers a `scale_up` on the winner's parent Meta adset (via `iteration_actions`). The step is bounded by the policy's `scale_up_step_pct` / `scale_up_cap_pct`. Each action carries the source `meta_ad_id` + its ROAS + the parent `adset_id`.
- `kill` — a scorecard adset ([[../tables/iteration_scorecards_daily]]) below the policy's `roas_floor` with spend ≥ `pause_min_spend_cents` triggers a `pause` (via `iteration_actions`). The action cites the highest-spend child ad's `meta_ad_id` as the "source of the decline" so the audit trail names a creative, not just the wrapper.
- `replenish` — when the test cohort ([[../tables/media_buyer_test_cohorts]]) has fewer than `cohortTargetCount` live ads, the agent picks from [[ready-to-test]] (top-of-bin, in ready order) and publishes each via the Phase 1 rail (`origin='media-buyer-test'`, `publish_active=true`). The cohort ceiling is enforced by [[media-buyer-publish-gate]].
- (implicit) `dormant` — no active [[../tables/iteration_policies]] row → NO actions; the pass records `media_buyer_no_active_policy` and returns. Never silent.

## Exports

### `MediaBuyerPlan` — interface

The typed plan a pass emits. `policyActive`, `policyVersionId`, `cohortConfigured`, `cohortTargetCount`, `currentTestCohortSize`, `promote[]`, `kill[]`, `replenish[]`, `summary`.

### `MediaBuyerPromoteAction` — interface

`{ kind: 'promote', sourceMetaAdId, roas, spendCents, targetLevel, targetObjectId, beforeBudgetCents, afterBudgetCents, rationale, policyVersionId, sourceAdCampaignId }`. The `sourceMetaAdId` + `roas` pair is the spec's verification citation.

### `MediaBuyerKillAction` — interface

`{ kind: 'kill', sourceMetaAdId, roas, spendCents, targetLevel, targetObjectId, rationale, policyVersionId }`.

### `MediaBuyerReplenishAction` — interface

`{ kind: 'replenish', adCampaignId, testMetaAdsetId, dailyTestCeilingCents, rationale }`.

### `MediaBuyerLoser` — interface

Input row for the plan-computer. `{ sourceMetaAdId, targetLevel, targetObjectId, roas, spendCents, triggeringScorecardId }`. The runner builds this from a scorecard `SELECT` + a `meta_ads` lookup that picks the highest-spend child ad per adset (the source of the decline).

### `computeMediaBuyerPlan(input: MediaBuyerPlanInputs): MediaBuyerPlan` — function

Pure. Takes fully-hydrated winners + losers + ready-to-test + cohort + policy + budgets, returns the typed plan. Encodes the four thresholds (`scale_up_roas_trigger`, `roas_floor`, `pause_min_spend_cents`, `never_pause_object_ids`) — the runner does no policy math itself.

### `runMediaBuyerLoop(admin, opts): Promise<{ plan, writes }>` — function

The orchestrator. Reads all inputs, computes the plan, persists the writes:

1. `iteration_actions` upsert for promote (scale_up) + kill (pause). Same shape [[../meta/execution]] reads — the executor picks them up next pass.
2. `director_activity` row per plan action + `media_buyer_pass_completed` heartbeat.
3. `ad_publish_jobs` insert per replenish (via the local `enqueueReplenishPublish` helper) + `ad-tool/publish-to-meta` event. Skipped with `media_buyer_replenish_missing_config` if the cohort lacks `default_meta_account_id` / `default_meta_page_id`.

Returns `{ plan, writes: { iterationActionsInserted, directorActivityRows, publishJobsInserted } }`.

## Policy contract — dormant without it

The Media Buyer refuses to autonomously act without an active [[../tables/iteration_policies]] row. On a pass with no policy:

- No `iteration_actions` writes.
- No `ad_publish_jobs` inserts.
- One `media_buyer_no_active_policy` [[../tables/director_activity]] row + a dormant summary in `plan.summary`.

The Growth Director (or a human) activates a conservative policy via `scripts/seed-media-buyer-iteration-policy.ts` — that opens the loop. The seed uses [[iteration-policy-authoring]] `authorIterationPolicy` + `activateIterationPolicy` (never raw upsert on `iteration_policies`).

**Conservative seed values** — 1.5× ROAS floor · 3.0× scale trigger · +15% step (cap 25%) · $100 pause min-spend · $10 per-pass account motion ceiling · 24h per-object cooldown.

## Test-cohort defaults contract

For the replenish path to actually insert `ad_publish_jobs` rows, the [[../tables/media_buyer_test_cohorts]] row needs its Phase-2 default publish targets set: `default_meta_account_id`, `default_meta_page_id`, `default_meta_instagram_user_id`. Migration `20260707130000_media_buyer_test_cohorts_publish_targets.sql` adds them (all NULLABLE). Without them, replenish is deferred with `media_buyer_replenish_missing_config` — the plan still emits the replenish action, the runner just doesn't fire the publish.

## Callers

- [[builder-worker]] `runMediaBuyerJob` — the box worker's `media-buyer` lane. Fans out over the workspace's connected `meta_ad_accounts` (or one explicit `meta_ad_account_id` in `job.instructions`) and calls `runMediaBuyerLoop` per account.

## Gotchas

- **The agent never writes Meta objects directly.** Every mutating call routes through `iteration_actions` → the Phase-6a executor OR through `ad_publish_jobs` → the Phase-1 gate → the publisher. A future adapter that ever calls `updateObjectStatus` / `updateObjectBudget` here breaks the north-star invariant and the box grader will catch it.
- **Loser's `source_meta_ad_id` is best-effort.** The scorecard grain is adset/campaign; the runner joins `meta_ads` in the losing adsets and picks the HIGHEST-SPEND child ad. When no children exist (a wrapped-empty adset), the fallback is the adset id itself. The pause target is unchanged — this is just the audit citation.
- **`per_object_cooldown_hours` is NOT enforced here.** The pause-cooldown is the decision engine's rule; the Media Buyer emits every eligible promote/kill on each pass, and the executor's own idempotency (`onConflict` on `(workspace_id, meta_ad_account_id, object_id, action_type, snapshot_date)`) collapses duplicates within a snapshot. The daily cadence + snapshot key together give a de-facto per-day cooldown.
- **Replenish is capped by BOTH the cohort deficit AND the ready-to-test bin.** A 3-target cohort with 2 live ads and 0 ready-to-test → 0 replenish + a summary flag that the bin is exhausted. That's the correct autonomous behavior — the Growth Director should top up the bin (via [[../inngest/ad-tool]] `ad-tool/generate-full`).
- **Publish-gate re-check is the safety net.** Even though the runner uses `cohort.testMetaAdsetId` as the adset, the publisher runs the Phase-1 gate again on the queued job. A cohort retired between the plan and the publish gets caught + escalated — the ad ships PAUSED.
- **`media_buyer_pass_completed` is ALWAYS emitted.** Even a no-op pass (no winners, no losers, no replenish) writes the heartbeat so the audit trail proves the pass ran. Absence of the row = the lane never fired = investigate the cron/enqueue path.

## Related

[[../tables/media_buyer_test_cohorts]] · [[media-buyer-publish-gate]] · [[../tables/ad_publish_jobs]] · [[../tables/iteration_policies]] · [[../tables/iteration_actions]] · [[../tables/iteration_scorecards_daily]] · [[../tables/director_activity]] · [[../tables/meta_ads]] · [[winning-creative-detect]] · [[ready-to-test]] · [[../meta/decision-engine]] · [[../meta/execution]] · [[builder-worker]] · [[iteration-policy-authoring]] · [[../specs/media-buyer-test-winner-loop]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
