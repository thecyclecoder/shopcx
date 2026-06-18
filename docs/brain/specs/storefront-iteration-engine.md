# Storefront Iteration Engine ⏳

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Storefront CRO"

Summary: An autonomous, daily-running engine that assesses Superfoods Company's storefront (sessions/engagement per PDP and lander variant) against Meta ad performance, reasons over it as an expert direct-response marketer / offer designer / media buyer, and produces typed, approvable recommendations (e.g. "shift spend to variant X", "test benefit angle Y from product intelligence", "launch a new static adset"). On approval it fires existing ShopCX systems to build Meta objects as drafts (never active) and create new ad/lander assets, so social marketing iterates continuously while Dylan keeps final control by flipping drafts live in Meta. Business outcome: higher blended ROAS and faster creative/offer iteration without manual analysis. This spec is grounded against the existing Amazing Coffee data (product intelligence, PDP + variants, ShopCX-built ads, storefront sessions) and is intended to be refined with Opus once Phase 0 confirms exact Brain schema.

## Phase 0 — Brain access & schema discovery ✅
Goal: give the build agent (and the Opus refinement pass) confirmed read access to docs/brain/ and produce a discovery doc that grounds all later phases in real tables/columns. No production code in this phase.
Grounding doc: [docs/brain/research/iteration-engine-grounding.md](../research/iteration-engine-grounding.md).
- ✅ Confirm build agent can read docs/brain/ at execution time
- ✅ Locate and read Brain docs for the four anchor areas; record exact file paths + key table/column names into a new doc docs/brain/research/iteration-engine-grounding.md
- ✅ Product intelligence shape (benefits, angles, claims, ingredients) for products like Amazing Coffee — benefit-angle string lives in `product_benefit_selections.benefit_name`, bridged to ads via `product_ad_angles.lead_benefit_anchor`
- ✅ Sessions / engagement model and grain (per-variant counts, add-to-cart, conversions) — `storefront_sessions`/`storefront_events`; variant parsed from `landing_url` (no first-class variant column), events 90d retention
- ✅ Attribution model: session/order → ad/campaign (UTMs or click IDs) and → PDP/lander variant — UTMs/click ids on `storefront_sessions`, `orders.attributed_utm_*`; session→ad join is convention-based (`utm_content`≈meta_ad_id) via `ad_publish_jobs`; no real Meta object keys on sessions/orders
- ✅ Meta connection structure (OAuth tokens, account IDs, any mirrored campaign/adset/ad entities) — `meta_connections`/`meta_ad_accounts`; only `daily_meta_ad_spend` account rollup exists, NO `meta_campaigns/adsets/ads` tables
- ✅ Document the existing ad-build → Meta publish path (create ad → generate AI copy → select ad account/campaign/adset → publish) and identify the internal function/endpoint that performs the publish, so Phase 6 can invoke a drafts-only variant — publish via `adToolPublishToMeta` (Inngest) → `createAd()` in `src/lib/meta-ads.ts`; drafts-only ALREADY exists (`ad_publish_jobs.publish_active=false` → PAUSED)
- ✅ Produce a "schema gaps" list (what exists vs. must be built) to feed the Opus refinement of Phases 1–6

## Phase 1 — Meta performance ingestion
Goal: store Meta campaign/adset/ad structure plus daily insights, since performance data is currently not stored anywhere.
- ⏳ New tables (names provisional, finalize in refinement): meta_campaigns, meta_adsets, meta_ads, meta_insights_daily (spend, impressions, clicks, CTR, CPC, purchases, revenue, ROAS, frequency — keyed by object_id + date)
- ⏳ Map ShopCX-built ads to their Meta ad IDs (extend the existing ad-build record table identified in Phase 0)
- ⏳ Meta Insights API daily pull job; idempotent upsert on (object_id, date)
- ⏳ Backfill last 90 days on first run, then incremental daily
- ⏳ Read Meta credentials/account IDs from the existing Meta connection (table confirmed in Phase 0)
- OPEN (refine): exact Meta-connection table + token refresh handling

## Phase 2 — Attribution & variant linkage
Goal: tie ad spend → session → PDP/lander variant → order so per-variant unit economics exist.
- ⏳ Confirm attribution keys from Phase 0 (UTM params and/or click id stored on sessions)
- ⏳ If attribution capture is missing, define the capture mechanism (split into its own spec, flagged here)
- ⏳ Build rollup join: meta_ad → sessions → PDP/lander variant → orders/revenue
- ⏳ Persist attributed spend and revenue at the (ad, variant, date) grain
- OPEN (refine): real session and order table/column names; confirm whether attribution already exists or must be built

## Phase 3 — Metrics rollups / scorecards
Goal: deterministic daily metrics that the recommendation engine reads (engine never queries raw tables directly).
- ⏳ Per-variant scorecard: sessions, ATC rate, CVR, revenue, attributed spend, ROAS, trend vs. prior period
- ⏳ Per-ad scorecard: spend, ROAS, CTR, frequency, fatigue signals (CTR decline, rising frequency), days live
- ⏳ Per-angle scorecard: map ads → benefit angle (from product intelligence) → aggregate performance
- ⏳ Persist to iteration_scorecards_daily for traceability and to anchor recommendation rationale
- OPEN (refine): benefit-angle field path inside product intelligence schema

## Phase 4 — Recommendation engine (hybrid, no execution)
Goal: generate typed, approvable recommendations through reasoning only — strictly no side effects in this phase.
- ⏳ Deterministic rules layer flags candidates: ROAS below floor → kill; proven winner with headroom → scale; variant high CVR but low spend → more ads; ad fatigue → new creative
- ⏳ LLM layer with three explicit personas (expert direct-response marketer, expert offer designer, expert media buyer) reasons over scorecards + product intelligence and produces structured recommendations
- ⏳ Typed recommendation schema, action enum: scale_ad, kill_ad, new_static_adset, new_video_adset, new_campaign, test_benefit_angle, new_lander_variant, offer_test
- ⏳ Each recommendation carries: target object, rationale, source metrics, expected impact, confidence, persona
- ⏳ Table: iteration_recommendations (status: pending | approved | rejected | executed | failed)
- ⏳ Admin review surface to approve/reject (location TBD in refinement)
- OPEN (refine): prompt grounding — feed real product intelligence + scorecard JSON shapes from Phase 0/3

## Phase 5 — Daily cron orchestration
Goal: wire the pipeline into a single reliable daily run.
- ⏳ Cron sequence: ingest (P1) → attribution refresh (P2) → rollups (P3) → recommend (P4)
- ⏳ Run records table with status, timing, counts; alert on failure
- ⏳ Re-run safety: each stage idempotent so a re-run never double-writes or double-recommends
- ⏳ Skip recommendation generation for objects with insufficient data (min spend / min sessions thresholds)

## Phase 6 — Execution adapters (drafts only, approval-gated)
Goal: on approval, fire existing ShopCX systems to build assets and Meta objects as drafts; Dylan flips them active in Meta.
- ⏳ One adapter per action type, each behind approval gate; ship and verify one action type at a time
- ⏳ kill_ad / scale_ad: adjust via Meta API (pause or budget change) — confirm whether budget change counts as "active" change with Dylan before enabling
- ⏳ new_static_adset / new_video_adset / new_campaign: create Meta objects in PAUSED/draft state, with audience + campaign settings, using the publish path from Phase 0
- ⏳ test_benefit_angle / new_lander_variant: invoke existing ad-build and lander-variant creation systems
- ⏳ Tag every engine-created Meta object with a stable marker (naming convention or label) so engine-created objects are always identifiable
- ⏳ Write executed action + external IDs back to iteration_recommendations (status executed) for idempotency
- OPEN (refine): exact internal function/endpoint names for ad-build, lander-variant, and Meta publish

## Safety / invariants
- The engine never sets a Meta object to active; all created campaigns/adsets/ads are draft/paused only. Dylan flips them live.
- Every execution is approval-gated; nothing in Phase 6 runs without an approved recommendation.
- All executions are idempotent — a cron re-run or duplicate approval must not create duplicate drafts or duplicate spend changes.
- Every engine-created Meta object is tagged/named so it is unambiguously identifiable as engine-created.
- Recommendations cite the source metrics/scorecard rows they were derived from.
- Phases 4 and earlier have zero external write side effects.
- Ship execution adapters (Phase 6) one action type at a time, each verified before the next is enabled.
- Engine reads metrics from scorecard tables (Phase 3), never directly from raw session/insight tables.

## Completion criteria
- Phase 0 grounding doc exists with confirmed file paths and table/column names for product intelligence, sessions, attribution, and Meta connection.
- Daily cron ingests Meta performance and stores structure + insights for Amazing Coffee's ads (Phase 1) verified against Meta UI numbers.
- Attributed spend/revenue exists at (ad, variant, date) grain for Amazing Coffee (Phase 2).
- Daily scorecards populated for variants, ads, and angles (Phase 3).
- Engine produces typed, rationale-backed recommendations visible for approval (Phase 4) with no side effects.
- Cron runs end-to-end daily, idempotently, with run records and failure alerting (Phase 5).
- At least one execution adapter creates a correctly-tagged Meta draft on approval and records external IDs back (Phase 6).
- Dylan can review a daily list of recommendations, approve one, and see a corresponding draft appear in Meta without it going live.