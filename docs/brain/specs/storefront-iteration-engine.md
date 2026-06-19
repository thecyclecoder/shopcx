# Storefront Iteration Engine 🚧

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

## Phase 2b — Attribution hardening (fast-follow) ⏳
Goal: stop depending on URL parsing; make attribution survive cross-session conversion.
- ⏳ Migration: add `advertorial_page_id uuid` (+ resolved `ad_campaign_id uuid`) to `storefront_sessions` and `orders`
- ⏳ Populate `advertorial_page_id` at pixel time on the session and at checkout on the order
- ⏳ Scorecard logic prefers the persisted column; falls back to the URL-parse join (Phase 2) when null
- ⏳ Track migration of coverage upward as persisted ids populate

## Phase 3 — Metrics rollups / scorecards ⏳
Goal: deterministic daily metrics the controller reads (engine never queries raw tables directly). Primary grain is adset/campaign; ad is an input roll-up.
- ⏳ `iteration_scorecards_daily` keyed by `(workspace_id, level, object_id, snapshot_date)`, `level` ∈ ad|adset|campaign|variant|angle
- ⏳ Adset/campaign scorecard (primary): spend, ROAS, CVR, revenue, CTR, frequency, days live, `creatives_live` count, trend vs. prior period, fatigue signals (CTR decline, rising frequency)
- ⏳ Per-ad scorecard (input): spend, ROAS, CTR, frequency, days live — rolls up into adset
- ⏳ Per-variant scorecard: sessions, ATC rate, CVR, revenue, attributed spend, ROAS, trend, `variant_attribution_coverage`
- ⏳ Per-angle scorecard: ad → `ad_campaigns.angle_id` → `product_ad_angles.lead_benefit_anchor` → `product_benefit_selections.benefit_name` (filter `role='lead' AND science_confirmed=true`, `is_active`); aggregate performance
- ⏳ Persist for traceability; recommendation + policy actions cite scorecard rows by id

## Phase 4 — Decision engine (two outputs, hybrid) ⏳
Goal: turn scorecards + active policy into actions. Two distinct outputs.
### 4a — Autonomous policy actions (no per-action approval, bounded by active policy)
- ⏳ Deterministic, policy-driven at adset/campaign grain: pause, scale up (≤ step cap), scale down, unpause, replenish thin adset with creative
- ⏳ Triggers from active `iteration_policies` version: ROAS floor, scale-up step % + cap, scale-down trigger, pause trigger (ROAS + min-spend + window), unpause trigger (sales-after-pause + lookback), min-creatives-per-adset (replacement trigger), per-object cooldown
- ⏳ Graduated failure response: a scaled adset dropping below floor scales budget back down first; pause only after a second consecutive bad window
- ⏳ Every action stamps the authorizing policy version id + triggering scorecard snapshot
### 4b — Approval-gated recommendations (new live spend lines)
- ⏳ LLM layer, three personas (direct-response marketer, offer designer, media buyer) reasons over scorecards + product intelligence
- ⏳ Action enum: `new_static_adset`, `new_video_adset`, `new_campaign`, `test_benefit_angle`, `new_lander_variant`, `offer_test`
- ⏳ Each recommendation carries: target object, rationale, source metrics, expected impact, confidence, persona
- ⏳ Table: `iteration_recommendations` (status: pending | approved | rejected | executed | failed)
- ⏳ Admin review surface to approve/reject (location finalized in build)

## Phase 4c — Policy + action ledger tables ⏳
Goal: the Growth Director's control surface + the engine's audit/idempotency/reversal substrate.
- ⏳ `iteration_policies`: typed thresholds (ROAS floor, scale step % + cap, scale-down trigger, pause trigger, unpause trigger, min-creatives-per-adset, per-object cooldown, per-account daily budget-delta ceiling), `version`, `status` (pending | active | superseded), `created_by` (agent | human), `rationale`, nullable `campaign_id` (per-campaign override reserved; global in v1)
- ⏳ Activation gate: human flips pending → active in v1; field design allows agent self-activation later with no migration; activating supersedes prior active version
- ⏳ `iteration_actions`: object level + id, action type, before/after budget/status, authorizing policy version id, triggering scorecard snapshot, external Meta result/ids, outcome-after fields for reversal tracking; idempotent per object + cooldown enforced
- ⏳ Engine treats both tables: policy read-only, actions append/update only

## Phase 5 — Daily cron orchestration ⏳
Goal: wire the pipeline into one reliable, self-correcting daily run.
- ⏳ Cron sequence: ingest (P1) → attribution refresh (P2/2b) → rollups (P3) → **reconcile prior actions (emit reversals: scale-down, unpause, replace)** → autonomous policy actions (4a) → recommendation generation (4b) → execute autonomous adapters (6a)
- ⏳ Run-records table with status, timing, counts; alert on failure
- ⏳ Re-run safety: every stage idempotent so a re-run never double-writes, double-recommends, or double-acts
- ⏳ Enforce per-object cooldown + per-account daily budget-delta ceiling across the whole run; exceeding flags for manual review instead of acting
- ⏳ Skip autonomous actions + recommendations for objects below min spend / min sessions thresholds
- ⏳ If no active policy version exists, run scorecards + 4b recommendations only; take zero autonomous actions

## Phase 6 — Execution adapters ⏳
Goal: execute decisions; manage live objects autonomously, create new spend lines as drafts only.
### 6a — Autonomous adapters (manage existing live objects, bounded by active policy)
- ⏳ pause / unpause: Graph status update on `meta_ad_id`/`meta_adset_id`
- ⏳ scale up (≤ step cap) / scale down: Graph budget update on the adset/campaign
- ⏳ replenish thin adset: upload replacement creative; **proven/reused creative into an existing live adset may go live; brand-new untested creative uploads as PAUSED draft**
- ⏳ Gated only by active policy + ledger idempotency + cooldown + ceiling; each action logged to `iteration_actions` with policy version + triggering snapshot
### 6b — Approval-gated adapters (new live spend lines, drafts only)
- ⏳ `new_static_adset` / `new_video_adset`: reuse `ad-tool/publish-to-meta` with `publish_active=false` → PAUSED, into an existing target campaign/adset
- ⏳ `new_campaign`: requires net-new `createCampaign` + `createAdSet` exports in `src/lib/meta-ads.ts` (do not exist today) — ship LAST, behind its own verification; created PAUSED/draft
- ⏳ `test_benefit_angle`: fire `ad-tool/generate-full` (or seed an `ad_campaigns` row with chosen `angle_id`), then publish drafts
- ⏳ `new_lander_variant`: `generateAdvertorialPagesForCampaign` (auto-runs at campaign `ready`); adapter picks angle + variant
- ⏳ Tag every engine-created Meta object with a stable marker via `ad_campaigns.name` convention (e.g. `[ie]` prefix); keep demographic terms out of the Meta object name
- ⏳ Write executed action + external ids back to `iteration_recommendations` (status executed) for idempotency
- ⏳ Ship execution adapters one action type at a time, each verified before the next is enabled

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

### Phase 2 — Attribution & variant linkage (shipped)
- Apply the migration: `npx tsx scripts/apply-meta-attribution-migration.ts` → expect `✓ applied 20260619140000_meta_attribution_daily.sql` and `✓ public.meta_attribution_daily has N columns`.
- In Supabase SQL editor, `select count(*) from public.meta_attribution_daily;` after a run → expect rows for Amazing Coffee's account once attribution has run.
- Trigger a run from the Inngest dev/prod UI: send event `meta/attribution-refresh` with `{ "workspace_id": "<ws>", "ad_account_id": "<meta_ad_accounts.id uuid>" }` → expect the function `meta-attribution-refresh` to complete and return `{ status:"complete", rows, coverage:{ variant_attribution_coverage, … } }`.
- Or run the upstream chain: send `meta/sync-performance` (or wait for the `meta-performance-daily` cron `30 11 * * *`) → expect it to fire `meta/attribution-refresh` as its final step, and the function logs `[meta-attribution] account <id> variant_attribution_coverage=<0..1>`.
- In `meta_attribution_daily`, `select variant, sum(attributed_spend_cents), sum(revenue_cents) from meta_attribution_daily where meta_ad_account_id='<id>' group by variant;` → expect resolved variants (`advertorial`/`beforeafter`/`reasons`) plus a `(unresolved)` bucket; per ad+day, the sum of `attributed_spend_cents` across variants equals that ad's `meta_insights_daily` ad-level spend (spend is conserved).
- Coverage sanity: the function's `coverage.variant_attribution_coverage` = `meta_revenue_resolved_cents / meta_revenue_total_cents`, between 0 and 1 (null only when there's no Meta revenue in the window); `meta_orders_without_ad` reports Meta orders with no `attributed_utm_content`.
- Idempotency: re-send `meta/attribution-refresh` for the same account → expect no duplicate rows (same `(workspace_id, meta_ad_id, variant, snapshot_date)` keys upserted, row count stable).