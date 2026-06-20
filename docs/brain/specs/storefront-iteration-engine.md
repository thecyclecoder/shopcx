# Storefront Iteration Engine ✅

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Storefront CRO"

Summary: An autonomous, daily-running controller that optimizes Superfoods Company's paid social **at the adset/campaign grain** against real Meta performance and storefront attribution. It computes per-ad/adset/campaign/variant/angle scorecards, then acts in two modes: (a) **autonomous policy actions** — pause, scale up/down, unpause, and replenish thin adsets with creative — executed without per-action approval but strictly bounded by an editable, versioned policy; and (b) **approval-gated recommendations** for anything that opens a new live spend line (new campaign/adset, new benefit angle, new lander variant), created draft/PAUSED only for Dylan to flip live. The policy layer is the control surface for a future **AI Growth Director** (human-overridable); the engine itself never edits policy. Business outcome: higher blended ROAS and continuous, self-correcting iteration at adset/campaign level without manual analysis. Grounded against existing Amazing Coffee data (product intelligence, PDP + variants, ShopCX-built ads, storefront sessions, Meta connection).

## Governance model
Three decoupled roles:
- **Engine (this spec)** = executor. Reads `iteration_policies` (active version) + `iteration_scorecards_daily`; writes `iteration_actions` and Meta changes. Never writes policy.
- **Growth Director** (AI agent, future — OUT OF SCOPE here; human-overridable) = governor. Writes new `iteration_policies` versions with rationale; reads `iteration_actions` + scorecards to retune. Never touches Meta directly.
- **Human** = override. Activates/supersedes policy versions; can pause or override the engine.

Design mandate: `iteration_policies`, `iteration_actions`, and `iteration_scorecards_daily` must be **agent-legible and agent-writable** (typed fields, rationale, authorship, versioning) so the Growth Director can operate them later with no migration. With **no active policy, the engine takes zero autonomous actions.**

## Phase 0 — Brain access & schema discovery ✅
Goal: confirmed read access to docs/brain/ + a discovery doc grounding later phases in real tables/columns. No production code.
Grounding doc: [docs/brain/research/iteration-engine-grounding.md](../research/iteration-engine-grounding.md).
- ✅ Confirm build agent can read docs/brain/ at execution time
- ✅ Locate + read Brain docs for the four anchor areas; record file paths + key table/column names
- ✅ Product intelligence shape — benefit-angle string in `product_benefit_selections.benefit_name`, bridged via `product_ad_angles.lead_benefit_anchor`
- ✅ Sessions / engagement model — `storefront_sessions`/`storefront_events`; variant via `landing_url` `?angle={slug}` → `advertorial_pages.slug`; events 90d retention
- ✅ Attribution model — UTMs/click ids on `storefront_sessions`; `orders.attributed_utm_*` first-touch backfilled since 2026-06-14; session→ad join convention-based (`utm_content`≈meta_ad_id) via `ad_publish_jobs`; no real Meta object keys on sessions/orders
- ✅ Meta connection — `meta_connections`/`meta_ad_accounts`; only `daily_meta_ad_spend` account rollup exists, NO `meta_campaigns/adsets/ads` tables
- ✅ Ad-build → Meta publish path — `ad-tool/publish-to-meta` (Inngest) → `createAd()` in `src/lib/meta-ads.ts`; drafts-only ALREADY native (`ad_publish_jobs.publish_active=false` → PAUSED)
- ✅ Schema-gaps list produced to feed refinement

## Phase 1 — Meta performance ingestion ✅
Goal: store Meta campaign/adset/ad structure + daily insights (none stored today).
- ✅ New tables: `meta_campaigns`, `meta_adsets`, `meta_ads` (structure + status + parent ids + budget), `meta_insights_daily` (spend, impressions, clicks, CTR, CPC, purchases, revenue, ROAS, frequency — keyed `(workspace_id, meta_object_id, level, snapshot_date)`, `level` ∈ campaign|adset|ad) — migration `20260618140000_meta_performance_tables.sql`
- ✅ Map ShopCX-built ads to Meta ids via existing `ad_publish_jobs.meta_ad_id`/`meta_adset_id`/`meta_campaign_id` (no new column needed) — documented on `meta_ads` brain page
- ✅ Insights pull: Graph v21.0 `GET /act_{meta_account_id}/insights` per level (`src/lib/meta/performance.ts`); account id bare on `meta_ad_accounts.meta_account_id` (client prefixes `act_`); token via `getMetaUserToken(workspaceId)` in `src/lib/meta-ads.ts` (handles decrypt + workspace fallback)
- ✅ Idempotent upsert on `(workspace_id, meta_object_id, level, snapshot_date)`
- ✅ Backfill last 90 days on first run, then incremental daily (`ingestMetaPerformance`; daily cron `meta-performance-daily` in `src/lib/inngest/meta-performance.ts`)
- ✅ Sanity check: reconcile `meta_insights_daily` account-total spend vs. existing `daily_meta_ad_spend` (`reconcileInsightsVsSpend`); flag drift beyond tolerance (>$1 AND >2%), surfaced via `console.warn` (Phase 5 will route to run-records/alerts)

## Phase 2 — Attribution & variant linkage ✅
Goal: tie ad spend → session → PDP/lander variant → order so per-variant unit economics exist.
Library `src/lib/meta/attribution.ts` (`computeVariantAttribution` / `refreshVariantAttribution`) → table `meta_attribution_daily`; Inngest `meta-attribution-refresh` fires after each `meta-sync-performance`. Migration `20260619140000_meta_attribution_daily.sql`.
- ✅ Ad grain off the order directly: `orders.attributed_utm_content` ≈ meta_ad_id (`attributed_utm_source='meta'`, first-touch, backfilled since 2026-06-14)
- ✅ Variant/angle resolution (v1, deterministic join): `orders` → `storefront_sessions` (by `customer_id`, first-touch with `utm_source='meta'`) → parse `?angle={slug}` from `landing_url` → match `advertorial_pages.slug` → resolve `(advertorial_page_id, angle_id, variant, campaign_id)`; `variant` read from the resolved `advertorial_pages` row
- ✅ Persist attributed spend + revenue at the `(meta_ad_id, variant, snapshot_date)` grain (`meta_attribution_daily`). **Spend allocated by SESSION share** across the variants an ad drove (revenue-proportional split would flatten per-variant ROAS); spend/revenue with no resolvable variant conserved in a `variant='(unresolved)'` bucket
- ✅ **Coverage metric (named, not silent):** each run reports `variant_attribution_coverage` (resolved ÷ total Meta-attributed revenue); the unresolved bucket (anonymous click → later direct-session conversion) is surfaced both as a row and in the run's coverage payload (`meta_orders_without_ad` counted too)
- OPEN (none — v1 join path confirmed)

## Phase 2b — Attribution hardening (fast-follow) ✅
Goal: stop depending on URL parsing; make attribution survive cross-session conversion.
Migration `20260619180000_attribution_persisted_ids.sql` (apply: `scripts/apply-attribution-persisted-ids-migration.ts`).
- ✅ Migration: add `advertorial_page_id uuid` + resolved `ad_campaign_id uuid` to `storefront_sessions` and `orders` (both nullable, FK `on delete set null`, partial indexes)
- ✅ Populate at pixel time on the session — `resolveLanderIds()` in `src/app/api/pixel/route.ts` resolves `?angle={slug}` → `advertorial_pages` on session INSERT (first-touch, alongside `landing_url`); at checkout on the order — `src/app/api/checkout/route.ts` copies the first-touch (or earliest lander) session's persisted ids onto the order
- ✅ Attribution logic (`src/lib/meta/attribution.ts`, feeds Phase 3 scorecards) prefers the persisted column (`resolveByPersistedId`); falls back to the URL-parse join (Phase 2 `resolveLander`) when null — for sessions, the converting order's own id, and the first-touch session
- ✅ Track migration of coverage upward — run coverage payload reports `meta_orders_resolved_via_persisted` (resolved off a persisted id vs URL parse); climbs as the columns populate on new traffic

## Phase 3 — Metrics rollups / scorecards ✅
Goal: deterministic daily metrics the controller reads (engine never queries raw tables directly). Primary grain is adset/campaign; ad is an input roll-up.
Library `src/lib/meta/scorecards.ts` (`computeScorecards` / `refreshScorecards`) → table `iteration_scorecards_daily`; Inngest `meta-scorecards-refresh` fires after each `meta-attribution-refresh`. Migration `20260619230000_iteration_scorecards_daily.sql` (apply: `scripts/apply-iteration-scorecards-migration.ts`).
- ✅ `iteration_scorecards_daily` keyed by `(workspace_id, level, object_id, snapshot_date)`, `level` ∈ ad|adset|campaign|variant|angle. Each row is a trailing-window rollup (default 7d) ending at `snapshot_date`, with the prior equal-length window persisted for trend/fatigue.
- ✅ Adset/campaign scorecard (primary): spend, ROAS, CVR, revenue, CTR, frequency, days live, `creatives_live` (ACTIVE child-ad count), trend vs. prior period (`*_delta_pct`), fatigue signals (`ctr_declining`, `frequency_rising`, `fatigue_score`) — from `meta_insights_daily` + `meta_*` structure
- ✅ Per-ad scorecard (input): spend, ROAS, CTR, frequency, days live; carries `parent_adset_id`/`parent_campaign_id` so it rolls up into adset/campaign
- ✅ Per-variant scorecard: sessions, ATC rate (`storefront_events` add_to_cart → session → variant), CVR (orders/sessions), revenue, attributed spend, ROAS, trend, `variant_attribution_coverage` — from `meta_attribution_daily`
- ✅ Per-angle scorecard: attribution aggregated by `angle_id`; benefit resolved `angle_id` → `product_ad_angles.lead_benefit_anchor` → `product_benefit_selections.benefit_name` (filter `role='lead' AND science_confirmed=true`); archived (`is_active=false`) angles skipped
- ✅ Persist for traceability; every row has a stable `id` so Phase 4/6 recommendations + policy actions cite scorecard rows by id. Idempotent upsert; engine reads this table only, never the raw tables.

## Phase 4 — Decision engine (two outputs, hybrid) ✅
Goal: turn scorecards + active policy into actions. Two distinct outputs.
Library `src/lib/meta/decision-engine.ts` (`runDecisionEngine` / `computeAutonomousActions` / `generateRecommendations` / `persistRecommendations`) → table `iteration_recommendations`; Inngest `meta-decision-engine` fires after each `meta-scorecards-refresh`. Migration `20260620140000_iteration_recommendations.sql` (apply: `scripts/apply-iteration-recommendations-migration.ts`). **Zero external (Meta) writes** — 4a decides (Phase 6a executes), 4b persists drafts.
### 4a — Autonomous policy actions (no per-action approval, bounded by active policy)
- ✅ Deterministic, policy-driven at adset/campaign grain: pause, scale up (≤ step cap), scale down, unpause, replenish thin adset with creative (`computeAutonomousActions`, pure function)
- ✅ Triggers from active `iteration_policies` version: ROAS floor, scale-up step % + cap, scale-down trigger, pause trigger (ROAS + min-spend + window), unpause trigger (sales-after-pause + lookback), min-creatives-per-adset (replacement trigger), per-object cooldown — typed `IterationPolicy` contract read via `loadActivePolicy` (**no active policy / no Phase 4c table ⇒ zero autonomous actions**)
- ✅ Graduated failure response: a scaled adset dropping below floor scales budget back down first; pause only after a second consecutive bad window (current + prior window below floor)
- ✅ Every action stamps the authorizing policy version id + triggering scorecard snapshot id; guardrail hits (budget floor, per-account daily delta ceiling, never-pause list) **escalate** (returned as `escalations`) instead of executing
- ⏳ NOTE: 4a **decides** only — persisting actions to `iteration_actions` (Phase 4c) + Meta execution (Phase 6a) are out of this phase; actions are returned + logged
### 4b — Approval-gated recommendations (new live spend lines)
- ✅ LLM layer ([[../libraries/ai-models]] `OPUS_MODEL`), three personas (direct-response marketer, offer designer, media buyer) reasons over scorecards + product intelligence (lead benefits + active angles)
- ✅ Action enum: `new_static_adset`, `new_video_adset`, `new_campaign`, `test_benefit_angle`, `new_lander_variant`, `offer_test`
- ✅ Each recommendation carries: target object, rationale, source metrics, expected impact, confidence, persona, cited scorecard ids
- ✅ Table: `iteration_recommendations` (status: pending | approved | rejected | executed | failed); idempotent upsert on `(workspace_id, meta_ad_account_id, snapshot_date, action_type, dedup_key)`
- ✅ Admin review surface to approve/reject: `GET /api/ads/iteration-recommendations` (list) + `POST /api/ads/iteration-recommendations/[id]` (`{ action: "approve" | "reject" }`); approval flips status only (Phase 6b executes)

## Phase 4c — Policy + action ledger tables ✅
Goal: the Growth Director's control surface + the engine's audit/idempotency/reversal substrate.
Migration `20260620150000_iteration_policy_action_tables.sql` (apply: `scripts/apply-iteration-policy-action-migration.ts`). Tables documented at [[../tables/iteration_policies]] + [[../tables/iteration_actions]]. The decision engine already reads both read-only ([[../libraries/meta__decision-engine]] `loadActivePolicy`/`loadRecentActions`); `persistActions` (append/update only) added in the same library.
- ✅ `iteration_policies`: typed thresholds (ROAS floor, scale step % + cap, scale-down trigger, pause trigger, unpause trigger, min-creatives-per-adset, per-object cooldown, per-account daily budget-delta ceiling), `version`, `status` (pending | active | superseded), `created_by` (agent | human), `rationale`, nullable `campaign_id`/`meta_ad_account_id` (per-campaign/account override reserved; global in v1). Exactly matches the `IterationPolicy` contract `loadActivePolicy` consumes.
- ✅ Activation gate: human flips pending → active in v1 (`activated_by`/`activated_at`); field design (`created_by='agent'`) allows agent self-activation later with no migration; activating supersedes prior active version (`superseded_by`/`superseded_at`), enforced by partial unique index `iteration_policies_one_active_idx` (≤ 1 active global policy per workspace)
- ✅ `iteration_actions`: object level + id, action type, before/after budget/status, authorizing policy version id, triggering scorecard snapshot, external Meta result/ids (`external_result`), outcome-after fields (`outcome_roas`/`outcome_revenue_cents`/`outcome_window_days`) + reversal links (`reverses_action_id`/`reversed_by_action_id`); idempotent per object via unique `(workspace_id, meta_ad_account_id, object_id, action_type, snapshot_date)`; cooldown enforced in code (`loadRecentActions` + `per_object_cooldown_hours`)
- ✅ Engine treats both tables: policy read-only (`loadActivePolicy`/`loadRecentActions`), actions append/update only (`persistActions`, NOT wired into `runDecisionEngine` so Phase 4 keeps zero side effects — the Phase 5 cron persists after the engine returns)

## Phase 5 — Daily cron orchestration ✅
Goal: wire the pipeline into one reliable, self-correcting daily run.
Library `src/lib/meta/iteration-run.ts` (run records + reconcile/reversal + noise floors); Inngest `meta-iteration-run` in `src/lib/inngest/meta-performance.ts` (the consolidated durable run); the daily cron `meta-performance-daily` now fires `meta/iteration-run` per active account. Migration `20260620170000_iteration_runs.sql` (apply: `scripts/apply-iteration-runs-migration.ts`). Table documented at [[../tables/iteration_runs]]; library at [[../libraries/meta__iteration-run]].
- ✅ Cron sequence (one durable run): ingest (P1) → attribution refresh (P2/2b) → rollups (P3) → **reconcile prior actions (measure outcomes + link reversals: scale-down reverts scale-up, unpause reverts pause)** → autonomous policy actions (4a) → recommendation generation (4b) → persist 4a decisions to `iteration_actions` → execute autonomous adapters (6a — Phase 6 hook; decided actions left `status='decided'`)
- ✅ Run-records table `iteration_runs` with status, timing (`duration_ms` + per-stage `ms`), counts (jsonb); failure writes the failed run record + DMs owners via `notifyOpsAlert`
- ✅ Re-run safety: every stage idempotent (scorecards/attribution/recs/actions all upsert on stable keys; reconcile only touches un-evaluated rows) so a same-day re-run never double-writes, double-recommends, or double-acts; `iteration_runs` is append-only run history
- ✅ Enforce per-object cooldown + per-account daily budget-delta ceiling across the whole run (inside `computeAutonomousActions`); exceeding flags for manual review — persisted as `status='escalated'` rows with the `guardrail` that fired, never executed
- ✅ Skip autonomous actions + recommendations for objects below min spend / min sessions thresholds — `MIN_ACTION_SPEND_CENTS` ($5) / `MIN_VARIANT_SESSIONS` (30) passed to `runDecisionEngine` (module constants in v1; candidate to migrate into `iteration_policies` later)
- ✅ If no active policy version exists, run scorecards + 4b recommendations only; take zero autonomous actions (`policy_active=false` on the run record)

## Phase 6 — Execution adapters ✅
Goal: execute decisions; manage live objects autonomously, create new spend lines as drafts only.
Libraries `src/lib/meta/execution.ts` (6a — `executeAutonomousActions`) + `src/lib/meta/recommendation-execute.ts` (6b — `executeRecommendation`). New Graph writes `updateObjectStatus`/`updateObjectBudget` in `src/lib/meta-ads.ts`. 6a runs as the cron's stage 7 (`meta-iteration-run`); 6b fires `meta/execute-recommendation` (Inngest `meta-execute-recommendation`) on approval. Migration `20260620180000_ad_publish_jobs_engine_fields.sql` (apply: `scripts/apply-ad-publish-jobs-engine-fields-migration.ts`) adds `ad_publish_jobs.ad_name` (engine tag) + `recommendation_id` (write-back link). **Shipped one action type at a time** via explicit `ENABLED_ADAPTERS` allow-lists.
### 6a — Autonomous adapters (manage existing live objects, bounded by active policy)
- ✅ pause / unpause: Graph status update (`updateObjectStatus`) on the adset/campaign
- ✅ scale up (≤ step cap) / scale down: Graph budget update (`updateObjectBudget`) on the same budget field (daily/lifetime) the object already uses
- ⏭️ **Next increment (adapter not yet enabled):** replenish thin adset — upload replacement creative; **proven/reused creative into an existing live adset may go live; brand-new untested creative uploads as PAUSED draft**. Decided `replenish_creative` rows are left `status='decided'` until this adapter ships (not in `ENABLED_ADAPTERS`).
- ✅ Gated only by active policy + ledger idempotency + cooldown + ceiling (all enforced upstream by the decision engine; the executor only applies `status='decided'` rows, never `escalated`); each executed action flips its `iteration_actions` row to `executed`/`failed` with `external_result` + `executed_at`. Self-correcting: a `scale_down` reverting a prior `scale_up` executes here.
### 6b — Approval-gated adapters (new live spend lines, drafts only)
- ✅ `new_static_adset` / `new_video_adset`: reuse `ad-tool/publish-to-meta` with `publish_active=false` → PAUSED, into the existing target adset; concrete build inputs (`ad_campaign_id`, `meta_adset_id`, `meta_page_id`, `destination_url`) read from the recommendation's `params`; missing inputs ⇒ left `status='approved'` with `external_result.deferred` (never guessed)
- ⏭️ **Next increment (deferred, ship LAST):** `new_campaign` — requires net-new `createCampaign` + `createAdSet` exports (objective + targeting + optimization decisions not yet specified — see Open questions); created PAUSED/draft. Recognized but deferred (`external_result.deferred`).
- ⏭️ **Next increment (deferred):** `test_benefit_angle` — seed an `ad_campaigns` row with the chosen `angle_id` + fire `ad-tool/generate-full`, then publish drafts.
- ⏭️ **Next increment (deferred):** `new_lander_variant` — `generateAdvertorialPagesForCampaign` for the chosen angle + variant.
- ⏭️ **Next increment (deferred):** `offer_test` — a pricing/bundle/guarantee change, not an ad publish (product decision).
- ✅ Tag every engine-created Meta object with a stable `[ie]` marker via `ad_publish_jobs.ad_name` (the publisher prefers it over `ad_campaigns.name`); demographic terms kept out of the Meta object name
- ✅ Write executed action + external ids back to `iteration_recommendations` (`status='executed'`, `external_result.meta_ad_id/...`) for idempotency; the dispatcher records `ad_publish_job_id` immediately + short-circuits an already-dispatched row
- ✅ Ship execution adapters one action type at a time, each verified before the next is enabled (`ENABLED_ADAPTERS` allow-lists in both libraries — enabling a deferred type is a one-line, reviewable change)

**Open questions (deferred adapters):**
- `new_campaign` / a fully engine-authored adset needs a default **objective**, **optimization goal**, **billing event**, **bid strategy**, and **targeting/audience** — none are in the spec. These determine whether an engine-created adset is even valid, so `createAdSet` is intentionally not built yet. Decision needed before enabling `new_campaign` / `test_benefit_angle` end-to-end.

## Safety / invariants
- Autonomy is bounded entirely by the **active approved policy version**; with no active policy, the engine takes zero autonomous actions.
- The engine may **pause/unpause** and **scale budget up (≤ step cap) or down** on existing live objects; it may **never set ACTIVE on a draft/new object** and **never create a new live spend line** — those are draft-only + Dylan-flip.
- New campaigns/adsets/ads are always created draft/PAUSED.
- Brand-new untested replacement creative uploads as PAUSED draft; only proven/reused creative into an existing live adset may go live.
- Failure response is graduated: scale back down before pausing; pause only after a second consecutive bad window.
- Every autonomous action is logged to `iteration_actions` with the authorizing policy version + triggering scorecard snapshot — reversible and idempotent per object.
- Per-object cooldown + per-account daily budget-delta ceiling are hard stops; exceeding them flags for manual review instead of acting.
- Every execution path is idempotent — a cron re-run, duplicate approval, or duplicate trigger must not create duplicate drafts or duplicate spend changes.
- Every engine-created Meta object is tagged/named so it is unambiguously identifiable as engine-created.
- Recommendations and autonomous actions cite the scorecard rows they were derived from.
- The engine never writes `iteration_policies`; only the Growth Director (or human) does. Policy edits are versioned + approval-gated; the active version id stamps every action.
- Phases 4b and earlier (scorecards/recommendations) have zero external write side effects; external writes occur only in Phase 6.
- Engine reads metrics from scorecard tables (Phase 3), never directly from raw session/insight tables.
- **Supervisable, not silent.** The engine is a *tool* governed by the policy layer (the Growth Director's control surface; [[../functions/growth]]). It MUST (a) **surface its reasoning** with every action/recommendation — the trigger conditions and policy rule invoked (e.g. "scale-down: ROAS < floor for 2 windows, reverting +20% step"); and (b) **respect policy guardrails** — budget floor, daily ceiling, and a "never fully pause" list — so proxy optimization (ROAS) can't drive a degenerate state (budget→0) that destroys the objective (revenue). Hitting a guardrail escalates (flags for the Growth Director / human), it is not silently executed.

## Completion criteria
- Phase 0 grounding doc exists with confirmed file paths and table/column names for product intelligence, sessions, attribution, and Meta connection.
- Daily cron ingests Meta performance and stores structure + insights for Amazing Coffee's ads (Phase 1), verified against Meta UI numbers and reconciled against `daily_meta_ad_spend`.
- Attributed spend/revenue exists at `(meta_ad_id, variant, date)` grain for Amazing Coffee with a reported `variant_attribution_coverage` (Phase 2); persisted-id hardening landed (Phase 2b).
- Daily scorecards populated for ads, adsets, campaigns, variants, and angles (Phase 3).
- `iteration_policies` and `iteration_actions` exist as typed, versioned, agent-legible tables; engine reads active policy and refuses all autonomous action when none is active (Phase 4c).
- Engine produces typed, rationale-backed recommendations for new spend lines (Phase 4b) with no side effects, and autonomous policy actions (Phase 4a) bounded by active policy.
- Cron runs end-to-end daily, idempotently, with a reconciliation/reversal stage, run records, and failure alerting (Phase 5).
- At least one autonomous adapter (e.g. scale-down or pause) executes within policy, logs to `iteration_actions`, and self-corrects on a subsequent run (Phase 6a).
- At least one approval-gated adapter creates a correctly-tagged Meta draft on approval and records external IDs back (Phase 6b).
- Dylan can review the active policy + a daily list of autonomous actions and pending recommendations, edit/approve a policy version, and see autonomous management plus draft creation happen without anything going live unintentionally.

## Verification

### Phase 6 — Execution adapters (shipped)
- Apply the migration: `npx tsx scripts/apply-ad-publish-jobs-engine-fields-migration.ts` → expect `✓ applied 20260620180000_ad_publish_jobs_engine_fields.sql` then `✓ public.ad_publish_jobs.ad_name present` and `✓ public.ad_publish_jobs.recommendation_id present`.
- In the Supabase SQL editor, confirm the columns: `select column_name from information_schema.columns where table_name='ad_publish_jobs' and column_name in ('ad_name','recommendation_id');` → expect both rows.
- **6a — autonomous adapter executes within policy + self-corrects:**
  - With an active `iteration_policies` row and a real adset below the ROAS floor with enough spend, send `meta/iteration-run` for the account → the run's stage 7 (`execute`) is `status='ok'`; `select status, action_type, external_result, executed_at from iteration_actions where meta_ad_account_id='<id>' and snapshot_date='<date>';` → the `pause`/`scale_down`/`scale_up`/`unpause` rows are now `status='executed'` with `external_result.graph_response` (status flip) or `external_result.applied_budget_cents` (budget) + non-null `executed_at`, and the Meta object reflects the change in the Ads Manager.
  - **Enabled allow-list:** a decided `replenish_creative` row stays `status='decided'` after the run (adapter not in `ENABLED_ADAPTERS`); it is counted in the run's `execute` stage `skipped`.
  - **Self-correction:** on a later run where a previously `scale_up`-ed object dropped below floor, the new `scale_down` is decided, executed (budget cut on Meta), and linked (`reverses_action_id`) — the prior `scale_up` flips to `reversed`.
  - **Idempotency / re-run safety:** re-send the same `meta/iteration-run` → already-`executed` rows are NOT re-applied (the executor only touches `status='decided'`), so no duplicate Graph writes; the run's `execute` stage shows `executed=0`.
  - **No token / no decided rows ⇒ no-op:** with no Meta token (or no active policy ⇒ no decided rows), stage 7 runs clean with `executed=0 failed=0` and changes nothing.
- **6b — approval-gated adapter creates a tagged draft + writes ids back:**
  - Seed a `pending` `new_static_adset` recommendation whose `params` carry real build inputs (`ad_campaign_id` of a built `ad_campaigns` with ready media, an existing `meta_adset_id`, `meta_page_id`, `destination_url`). `POST /api/ads/iteration-recommendations/<id>` `{ "workspaceId":"<ws>", "action":"approve" }` as an owner → `{ recommendation:{ status:"approved" } }` and a `meta/execute-recommendation` event fires.
  - The `meta-execute-recommendation` function logs `→ executed`; `select status, external_result from iteration_recommendations where id='<id>';` → `external_result.ad_publish_job_id` set (status `publishing`); the linked `ad_publish_jobs` row has `publish_active=false`, `ad_name` starting `[ie] `, and `recommendation_id=<id>`.
  - After the publisher completes, the recommendation flips to `status='executed'` with `external_result.meta_ad_id`/`meta_creative_id` and the Meta ad exists **PAUSED** (never live) under an `[ie] …` name.
  - **Deferred types:** approve a `new_campaign` (or `test_benefit_angle`/`new_lander_variant`/`offer_test`) recommendation → it stays `status='approved'` with `external_result.deferred='adapter_deferred:<type>'`; **no Meta object created**.
  - **Missing inputs ⇒ deferred, not guessed:** approve a `new_static_adset` lacking `ad_campaign_id` → stays `approved` with `external_result.deferred='missing_build_inputs:ad_campaign_id,…'`; no publish job created.
  - **Idempotency:** re-fire `meta/execute-recommendation` for an already-dispatched row → result `skipped (already_dispatched)`; no second `ad_publish_jobs` row (`select count(*) from ad_publish_jobs where recommendation_id='<id>';` = 1).
- **Safety invariant — never goes live:** every engine-created Meta object is PAUSED; confirm no `ad_publish_jobs` row created by the engine has `publish_active=true`, and 6a never sets `ACTIVE` on a draft/new object (it only flips status on existing objects + adjusts budget).

### Phase 5 — Daily cron orchestration (shipped)
- Apply the migration: `npx tsx scripts/apply-iteration-runs-migration.ts` → expect `✓ applied 20260620170000_iteration_runs.sql` then `✓ public.iteration_runs has N columns`.
- In the Supabase SQL editor, confirm the table + CHECKs: `select column_name from information_schema.columns where table_name='iteration_runs';` → expect the [[../tables/iteration_runs]] columns; `select conname from pg_constraint where conrelid='public.iteration_runs'::regclass and contype='c';` → CHECKs on `trigger`, `status`.
- **End-to-end run:** trigger the consolidated pipeline from the Inngest dev/prod UI — send event `meta/iteration-run` with `{ "workspace_id":"<ws>", "ad_account_id":"<meta_ad_accounts.id uuid>", "meta_account_id":"<bare meta account id>", "trigger":"manual" }` → expect the function `meta-iteration-run` to complete and a log line `[meta-iteration-run] account <id> <date> policy_active=<bool> actions=<n> escalations=<n> reversals=<n> recs=<n>`. Then `select status, snapshot_date, policy_active, duration_ms, counts, jsonb_array_length(stages) as n_stages from iteration_runs where meta_ad_account_id='<id>' order by started_at desc limit 1;` → expect `status='complete'`, a `snapshot_date`, `duration_ms>0`, and `n_stages=7` (ingest, attribution, rollups, reconcile, decide, persist-actions, execute).
- **Daily cron drives it:** confirm `meta-performance-daily` (cron `30 11 * * *`) now fans out `meta/iteration-run` (not `meta/sync-performance`) — one event per active [[../tables/meta_ad_accounts]] row.
- **No active policy ⇒ recs only, zero actions:** with no `iteration_policies` active row, run `meta/iteration-run` → the latest `iteration_runs` row has `policy_active=false`, `counts->>'actions_decided'='0'`, and `counts->>'recommendations'` ≥ 0 (4b still runs). No new `iteration_actions` rows for that snapshot.
- **Active policy ⇒ actions persisted + run-wide guardrails:** insert one active `iteration_policies` row, run `meta/iteration-run` → `iteration_runs.policy_active=true` with `policy_version_id` = that row's id; `select status, count(*) from iteration_actions where meta_ad_account_id='<id>' and snapshot_date='<date>' group by status;` → `decided` rows for executable actions and `escalated` rows (with `guardrail` set) for any that breached the budget floor / per-account daily delta ceiling / never-pause list.
- **Noise floors:** an adset/campaign with trailing-window spend < $5 (or a variant with < 30 sessions) produces NO `iteration_actions` row and is absent from the recommendation context for that run.
- **Reconcile / reversals:** with a prior un-reversed `scale_up` whose object now sits below ROAS floor, a run that emits a `scale_down` for it → `select reverses_action_id from iteration_actions where action_type='scale_down' and object_id='<id>' and snapshot_date='<date>';` is the prior scale_up's id, and that prior row flips to `status='reversed'` with `reversed_by_action_id` set. Prior matured actions (older than 3 days, unevaluated) get `outcome_roas`/`outcome_revenue_cents`/`outcome_evaluated_at` populated.
- **Re-run safety:** re-send the same `meta/iteration-run` → a NEW `iteration_runs` row is appended, but `iteration_actions`/`iteration_recommendations` row counts for that `(account, snapshot_date)` are stable (no duplicates, no double-acts).
- **Failure alert:** force a stage error (e.g. no Meta token) → the latest `iteration_runs` row is `status='failed'` with a non-null `error`, and workspace owners/admins receive a `notify-ops-alert` Slack DM "Iteration engine daily run failed".

### Phase 4c — Policy + action ledger tables (shipped)
- Apply the migration: `npx tsx scripts/apply-iteration-policy-action-migration.ts` → expect `✓ applied 20260620150000_iteration_policy_action_tables.sql` then `✓ public.iteration_policies has N columns` and `✓ public.iteration_actions has N columns`.
- In the Supabase SQL editor, confirm the tables + CHECKs: `select column_name from information_schema.columns where table_name='iteration_policies';` and `... where table_name='iteration_actions';` → expect the columns on the [[../tables/iteration_policies]] / [[../tables/iteration_actions]] pages. `select conname from pg_constraint where conrelid='public.iteration_policies'::regclass and contype='c';` → CHECKs on `status`, `created_by`; same on `iteration_actions` → CHECKs on `level`, `action_type`, `status`.
- Confirm the activation guard: `select indexname from pg_indexes where tablename='iteration_policies';` → includes `iteration_policies_one_active_idx` and `iteration_policies_version_idx`. Insert two `status='active'` global rows for one workspace (null `campaign_id`) → the second **fails** the partial unique index (proves ≤ 1 active global policy per workspace).
- **No-active-policy invariant still holds (core):** with the tables present but **no** `status='active'` row, send `meta/decision-engine` for the account → `loadActivePolicy` returns null → result `policy_active:false`, `autonomous.actions` empty, 4b recommendations still generated. (Same observable as before 4c, now backed by a real table rather than a missing one.)
- **Policy read → autonomous actions activate:** insert one `iteration_policies` row (`status='active'`, sane thresholds, null `campaign_id`/`meta_ad_account_id`) for the workspace, then re-send `meta/decision-engine` → result `policy_active:true`, `policy_version_id` = that row's id, and `autonomous.actions`/`escalations` populated per the scorecards. Each `ComputedAction.policy_version_id` equals the active row's id and `triggering_scorecard_id` references a real [[../tables/iteration_scorecards_daily]] row.
- **Ledger append/update + idempotency:** call `persistActions(p, snapshotDate, actions, escalations)` (e.g. from a one-off script after `runDecisionEngine`) → `iteration_actions` gets one row per action (`status='decided'`) and per escalation (`status='escalated'` with `guardrail` set). `select object_id, action_type, status, guardrail, policy_version_id, triggering_scorecard_id from iteration_actions where meta_ad_account_id='<id>' and snapshot_date='<date>';` → expect the rows; re-call with the same inputs → **row count stable** (same `(workspace_id, meta_ad_account_id, object_id, action_type, snapshot_date)` keys re-upserted, no duplicates).
- **Engine never writes policy:** confirm `persistActions` and the decision engine only touch `iteration_actions` (and `iteration_recommendations`) — `iteration_policies` is read-only to the engine; only the Growth Director / human inserts versions.

### Phase 4 — Decision engine (shipped)
- Apply the migration: `npx tsx scripts/apply-iteration-recommendations-migration.ts` → expect `✓ applied 20260620140000_iteration_recommendations.sql` then `✓ public.iteration_recommendations has N columns`.
- In the Supabase SQL editor, confirm the table + CHECKs: `select column_name from information_schema.columns where table_name='iteration_recommendations';` → expect the columns on the [[../tables/iteration_recommendations]] page; `select conname from pg_constraint where conrelid='public.iteration_recommendations'::regclass and contype='c';` → CHECKs on `action_type`, `status`, `persona`, `target_object_level`.
- Trigger a run from the Inngest dev/prod UI: send event `meta/decision-engine` with `{ "workspace_id": "<ws>", "ad_account_id": "<meta_ad_accounts.id uuid>" }` → expect the function `meta-decision-engine` to complete and return `{ status:"complete", snapshotDate, policy_active, policy_version_id, autonomous:{ actions, escalations, counts }, recommendations:{ generated, persisted, byType, byPersona } }`, and a log line `[meta-decision] account <id> <date> policy_active=<bool> actions=<n> escalations=<n> recs=<g>/<p>`.
- Or run the upstream chain: send `meta/scorecards-refresh` (or wait for the `meta-performance-daily` cron) → expect it to fire `meta/decision-engine` as its final step.
- **No active policy ⇒ zero autonomous actions (core invariant):** with no `iteration_policies` table/active row (Phase 4c not yet built), the run returns `policy_active:false` and `autonomous.actions` empty, while still generating 4b recommendations. Confirm in the function output.
- **4b recommendations land:** `select action_type, status, persona, confidence from iteration_recommendations where meta_ad_account_id='<id>' order by created_at desc;` → expect `status='pending'` rows with a valid `action_type` ∈ the enum, a `persona`, and non-empty `rationale`; `source_scorecard_ids` reference real [[../tables/iteration_scorecards_daily]] ids.
- **Idempotency:** re-send `meta/decision-engine` for the same account + `snapshot_date` → recommendation row count stable (same `(workspace_id, meta_ad_account_id, snapshot_date, action_type, dedup_key)` keys re-upserted, no duplicates).
- **Review surface:** `GET /api/ads/iteration-recommendations?workspaceId=<ws>&status=pending` as an owner/admin → expect the pending rows as JSON. `POST /api/ads/iteration-recommendations/<id>` with `{ "workspaceId":"<ws>", "action":"approve" }` → expect `{ recommendation:{ status:"approved", reviewed_at } }`; a second POST on the same row → `409 Already approved`. `action:"reject"` → `status='rejected'`. A non-member → `403`.
- **No external side effects:** confirm no Meta API calls and no `ad_publish_jobs`/`iteration_actions` writes occur during the run — Phase 4 only persists `iteration_recommendations` and logs the 4a decisions (Phase 6 executes).

### Phase 3 — Metrics rollups / scorecards (shipped)
- Apply the migration: `npx tsx scripts/apply-iteration-scorecards-migration.ts` → expect `✓ applied 20260619230000_iteration_scorecards_daily.sql` then `✓ public.iteration_scorecards_daily has N columns`.
- In Supabase SQL editor, confirm the table + check constraint: `select column_name from information_schema.columns where table_name='iteration_scorecards_daily';` → expect the columns above; `select distinct level from public.iteration_scorecards_daily;` after a run → a subset of `ad|adset|campaign|variant|angle`.
- Trigger a run from the Inngest dev/prod UI: send event `meta/scorecards-refresh` with `{ "workspace_id": "<ws>", "ad_account_id": "<meta_ad_accounts.id uuid>" }` → expect the function `meta-scorecards-refresh` to complete and return `{ status:"complete", snapshotDate, windowDays:7, rows, counts:{ad,adset,campaign,variant,angle}, variant_attribution_coverage }`, and a log line `[meta-scorecards] account <id> <date> rows=<n> coverage=<0..1>`.
- Or run the upstream chain: send `meta/sync-performance` (or wait for the `meta-performance-daily` cron `30 11 * * *`) → expect it to fire `meta/attribution-refresh`, which in turn fires `meta/scorecards-refresh` as its final step.
- Per-level sanity in `iteration_scorecards_daily` (one account, latest `snapshot_date`):
  - `select level, count(*) from iteration_scorecards_daily where meta_ad_account_id='<id>' and snapshot_date=(select max(snapshot_date) from iteration_scorecards_daily) group by level;` → expect rows at `ad`/`adset`/`campaign` (when Meta insights exist) and `variant`/`angle` (when attribution exists).
  - Adset/campaign rows carry `creatives_live` ≥ 0, `days_live` ≥ 0, and `roas_delta_pct`/`ctr_delta_pct` populated (null only when the prior window was empty); `ctr_declining`/`frequency_rising`/`fatigue_score` set.
  - Variant rows carry `sessions`, `atc`, `atc_rate` (≤ 1.0), `cvr` = orders/sessions, and a non-null `variant_attribution_coverage` (matches the upstream `meta-attribution-refresh` coverage for the window).
  - Angle rows carry `angle_id` + `lead_benefit_anchor`; `benefit_name` is non-null exactly when the anchor matches a `product_benefit_selections` row with `role='lead' AND science_confirmed=true`; no row exists for an `is_active=false` angle.
- Idempotency: re-send `meta/scorecards-refresh` for the same account + `snapshot_date` → row count stable (same `(workspace_id, level, object_id, snapshot_date)` keys re-upserted, no duplicates).
- Engine-reads-scorecards invariant: confirm the new library/Inngest reads attribution + insights (not the engine) — `iteration_scorecards_daily` is the only metrics table Phases 4/6 will query.

### Phase 2b — Attribution hardening (shipped)
- Apply the migration: `npx tsx scripts/apply-attribution-persisted-ids-migration.ts` → expect `✓ applied 20260619180000_attribution_persisted_ids.sql` then four `✓ public.{storefront_sessions|orders}.{advertorial_page_id|ad_campaign_id} present` lines.
- In Supabase SQL editor, confirm the columns + FKs: `select column_name from information_schema.columns where table_name='storefront_sessions' and column_name in ('advertorial_page_id','ad_campaign_id');` → expect both rows. Same for `orders`.
- New-session capture: visit a lander URL carrying `?variant=advertorial&angle={a real advertorial_pages.slug}` so the pixel fires, then `select advertorial_page_id, ad_campaign_id from storefront_sessions order by first_seen_at desc limit 1;` → expect the matching `advertorial_pages.id` and its `campaign_id` (non-null). A non-lander landing (no `?angle=`) → expect both null.
- New-order capture: place a storefront order from a customer whose first-touch (or earliest lander) session resolved a lander → `select advertorial_page_id, ad_campaign_id from orders where id='<order id>';` → expect the persisted ids copied from that session.
- Fallback intact: a session/order predating the migration (null `advertorial_page_id`) still resolves a variant via the URL parse — run `meta/attribution-refresh` and confirm pre-migration days still produce resolved variants (coverage unchanged), while post-migration traffic resolves off the persisted id.
- Coverage migration metric: in the `meta-attribution-refresh` result, `coverage.meta_orders_resolved_via_persisted` is 0 before any persisted ids exist and climbs (≤ `meta_orders_resolved`) as new attributed orders carry the column.

### Phase 2 — Attribution & variant linkage (shipped)
- Apply the migration: `npx tsx scripts/apply-meta-attribution-migration.ts` → expect `✓ applied 20260619140000_meta_attribution_daily.sql` and `✓ public.meta_attribution_daily has N columns`.
- In Supabase SQL editor, `select count(*) from public.meta_attribution_daily;` after a run → expect rows for Amazing Coffee's account once attribution has run.
- Trigger a run from the Inngest dev/prod UI: send event `meta/attribution-refresh` with `{ "workspace_id": "<ws>", "ad_account_id": "<meta_ad_accounts.id uuid>" }` → expect the function `meta-attribution-refresh` to complete and return `{ status:"complete", rows, coverage:{ variant_attribution_coverage, … } }`.
- Or run the upstream chain: send `meta/sync-performance` (or wait for the `meta-performance-daily` cron `30 11 * * *`) → expect it to fire `meta/attribution-refresh` as its final step, and the function logs `[meta-attribution] account <id> variant_attribution_coverage=<0..1>`.
- In `meta_attribution_daily`, `select variant, sum(attributed_spend_cents), sum(revenue_cents) from meta_attribution_daily where meta_ad_account_id='<id>' group by variant;` → expect resolved variants (`advertorial`/`beforeafter`/`reasons`) plus a `(unresolved)` bucket; per ad+day, the sum of `attributed_spend_cents` across variants equals that ad's `meta_insights_daily` ad-level spend (spend is conserved).
- Coverage sanity: the function's `coverage.variant_attribution_coverage` = `meta_revenue_resolved_cents / meta_revenue_total_cents`, between 0 and 1 (null only when there's no Meta revenue in the window); `meta_orders_without_ad` reports Meta orders with no `attributed_utm_content`.
- Idempotency: re-send `meta/attribution-refresh` for the same account → expect no duplicate rows (same `(workspace_id, meta_ad_id, variant, snapshot_date)` keys upserted, row count stable).