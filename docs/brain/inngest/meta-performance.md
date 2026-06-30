# inngest/meta-performance

Meta performance ingestion + variant attribution + scorecards + decision engine for
the Storefront Iteration Engine (Phases 1–5) — mirrors campaign/adset/ad structure +
daily object-grain insights and reconciles against the account rollup (P1), rolls up
per-variant attributed spend + revenue (P2), computes the deterministic daily
scorecards the controller reads (P3), then turns those scorecards + the active policy
into autonomous actions + approval-gated recommendations (P4). **Phase 5** folds the
whole sequence into one durable, run-recorded daily run (`meta-iteration-run`) with a
reconcile/reversal stage and a failure alert. **Phase 6** executes the decisions:
6a autonomous adapters run as the daily run's stage 7, and `meta-execute-recommendation`
turns an approved recommendation into a PAUSED Meta draft. **Phase 8** composes the
Growth Director's cross-tool allocation decision (stage 8 post-execute, [[../libraries/growth-allocation]]).
Delegates to [[../libraries/meta__performance]], [[../libraries/meta__attribution]],
[[../libraries/meta__scorecards]], [[../libraries/meta__decision-engine]],
[[../libraries/meta__iteration-run]], [[../libraries/meta__execution]] (6a),
[[../libraries/meta__recommendation-execute]] (6b), and [[../libraries/growth-allocation]] (8).

**File:** `src/lib/inngest/meta-performance.ts`

## Functions

### `meta-sync-performance`
- **Trigger:** event `meta/sync-performance`
- **Retries:** 2
- **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, meta_account_id, incremental_days? }`
- Calls `ingestMetaPerformance()`; `console.warn`s any reconciliation drift (Phase 5 will route to run-records/alerts). Fires `meta/attribution-refresh` after ingest so Phase 2 stays current.

### `meta-performance-daily`
- **Trigger:** cron `30 11 * * *` (6:30 AM Central — after `meta-daily-sync` account spend rollup)
- **Retries:** 1
- **Phase 5:** fans out a `meta/iteration-run` event (`trigger:"cron"`) per active [[../tables/meta_ad_accounts]] row — the consolidated, run-recorded pipeline (it no longer fires `meta/sync-performance`). The per-stage events below remain for manual/stage-by-stage debugging.

### `meta-iteration-run` (Phase 5)
- **Trigger:** event `meta/iteration-run`
- **Retries:** 1 · **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, meta_account_id, trigger?, incremental_days? }`
- Runs the whole pipeline as ONE durable run: **ingest (P1) → attribution (P2/2b) → rollups (P3) → reconcile prior actions → 4a autonomous actions + 4b recommendations → persist actions + link reversals → execute (6a) → growth-allocation (8)**. Opens an [[../tables/iteration_runs]] record (`status='running'`) up front; stamps `complete`/`failed` with per-stage timings + summary counts on finish; on any stage error writes the failed run record and fires [[../libraries/notify-ops-alert]]. Delegates to [[../libraries/meta__iteration-run]] (`startRun`/`finishRun`/`reconcilePriorActions`/`linkReversals`) + the P1–P4 + P8 libraries. Enforces Phase 5 noise floors (min spend / min sessions) via `runDecisionEngine` opts; per-object cooldown + per-account budget-delta ceiling + the no-active-policy invariant are enforced inside the decision engine. Persists 4a decisions to [[../tables/iteration_actions]] (`status='decided'`), then **stage 7 executes them** ([[../libraries/meta__execution]] `executeAutonomousActions` — pause/unpause/scale flip the row to `executed`/`failed`; un-enabled types like `replenish_creative` stay `decided`). **Stage 8** ([[../libraries/growth-allocation]] `runGrowthAllocationPass`) composes the daily allocation decision across Meta + Storefront, writes [[../tables/director_activity]] rows, and escalates ceiling-raises / new-platform entries to the Growth Director via [[../libraries/platform-director]]. Idempotent — only `status='decided'` rows execute, so a same-day re-run never double-writes/recommends/acts.

### `meta-execute-recommendation` (Phase 6b)
- **Trigger:** event `meta/execute-recommendation`
- **Retries:** 2 · **Concurrency:** `[{ limit: 2, key: "event.data.workspace_id" }]`
- **Event data:** `{ workspace_id, recommendation_id }`
- Fired by the review surface (`POST /api/ads/iteration-recommendations/[id]` on `approve`). Calls [[../libraries/meta__recommendation-execute]] `executeRecommendation` → for `new_static_adset`/`new_video_adset` creates a PAUSED [[../tables/ad_publish_jobs]] row (tagged `[ie]`, linked via `recommendation_id`) and fires `ad-tool/publish-to-meta`; other types are recognized but deferred (`external_result.deferred`). Idempotent: non-approved / already-dispatched rows short-circuit. **Never sets a new spend line live.**

### `meta-attribution-refresh` (Phase 2)
- **Trigger:** event `meta/attribution-refresh`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, incremental_days? }`
- Calls `refreshVariantAttribution()`; `console.log`s the `variant_attribution_coverage` metric (Phase 5 will route to run-records/alerts). Fires `meta/scorecards-refresh` after attribution lands so Phase 3 stays current.

### `meta-scorecards-refresh` (Phase 3)
- **Trigger:** event `meta/scorecards-refresh`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, snapshot_date?, window_days? }`
- Calls `refreshScorecards()`; `console.log`s the row count + per-level counts + coverage. Idempotent upsert into [[../tables/iteration_scorecards_daily]]. Fires `meta/decision-engine` after scorecards land so Phase 4 stays current.

### `meta-decision-engine` (Phase 4)
- **Trigger:** event `meta/decision-engine`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, snapshot_date? }`
- Calls `runDecisionEngine()` ([[../libraries/meta__decision-engine]]); `console.log`s `policy_active` + autonomous action/escalation counts + recommendations generated/persisted. **4a** autonomous actions are decided + returned (executed in Phase 6a, not here); **4b** recommendations are persisted PAUSED to [[../tables/iteration_recommendations]]. **No external (Meta) writes.** With no active [[../tables/iteration_policies]] version, zero autonomous actions are produced.

## Downstream events sent

- `meta/iteration-run` (from the daily cron — Phase 5 consolidated pipeline)
- `meta/sync-performance` (manual/debug entry to the per-stage chain)
- `meta/attribution-refresh` (from `meta-sync-performance`, after ingest)
- `meta/scorecards-refresh` (from `meta-attribution-refresh`, after attribution)
- `meta/decision-engine` (from `meta-scorecards-refresh`, after scorecards)
- `ad-tool/publish-to-meta` (from `meta-execute-recommendation` — Phase 6b draft publish)
- `meta/execute-recommendation` is sent from the review surface (`/api/ads/iteration-recommendations/[id]` on approve), consumed here

## Tables written

- [[../tables/meta_campaigns]]
- [[../tables/meta_adsets]]
- [[../tables/meta_ads]]
- [[../tables/meta_insights_daily]]
- [[../tables/meta_attribution_daily]] (Phase 2)
- [[../tables/iteration_scorecards_daily]] (Phase 3)
- [[../tables/iteration_recommendations]] (Phase 4b)
- [[../tables/iteration_actions]] (Phase 5 — `meta-iteration-run` persists 4a decisions + reversals; Phase 6a stage 7 flips to `executed`/`failed`)
- [[../tables/iteration_runs]] (Phase 5 — per-run audit record)
- [[../tables/ad_publish_jobs]] (Phase 6b — `meta-execute-recommendation` creates the PAUSED draft job)
- [[../tables/director_activity]] (Phase 8 — `growth-allocation` stamps allocation decisions + escalations)

## Tables read (not written)

- [[../tables/meta_ad_accounts]]
- [[../tables/meta_connections]]
- [[../tables/daily_meta_ad_spend]] (reconciliation)
- [[../tables/orders]] · [[../tables/storefront_sessions]] · [[../tables/advertorial_pages]] · [[../tables/customers]] (Phase 2 attribution)
- [[../tables/storefront_events]] · [[../tables/product_ad_angles]] · [[../tables/product_benefit_selections]] (Phase 3 scorecards)
- [[../tables/iteration_scorecards_daily]] · `iteration_policies` (Phase 4c, read-only) · [[../tables/meta_adsets]] · [[../tables/meta_campaigns]] (Phase 4 budgets) · [[../tables/product_ad_angles]] · [[../tables/product_benefit_selections]] (Phase 4b grounding)
- [[../tables/ad_spend_budgets]] · [[../tables/storefront_experiments]] (Phase 8 allocation read)

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
