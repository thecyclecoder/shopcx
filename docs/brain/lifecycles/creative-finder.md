# Lifecycle: creative finder (static competitor analysis)

Discovers long-running competitor + category static ads from [[../integrations/adlibrary]], reverse-engineers their structure (hook → mechanism claim → proof → offer skeleton) via vision, and mines cross-brand repetition patterns. The pattern matrix is the consumable hand-off for variant generation and — critically — for [[../libraries/ads__customer-voice-mining]] Phase 2 (the synthesizer scores customer-voice-mined angle candidates against the active pattern matrix before persisting to [[../tables/product_ad_angles]]).

**Owner:** [[../functions/growth]] · **Mandate:** Static-ad optimization

**Code:**
- Discovery: [[../libraries/adlibrary]] (`searchAds`, `fetchCreative`, `isLongRunner`)
- Deconstruction: [[../libraries/creative-skeleton]] (`visionDeconstruct`, `ingestAd`)
- Matrix: [[../libraries/creative-skeleton]] (`buildPatternMatrix`)
- Cron + events: [[../inngest/creative-finder]]
- Dashboard: `/dashboard/marketing/ads/winning` (Browse + Pattern matrix tabs)
- API: `/api/ads/creative-finder/*` (list, POST sweep, patterns, shortlist, media proxy)

## Flow: phases 1–5

### Phase 1 — Skeleton store
[[../tables/creative_skeletons]] (supabase/migrations/20260619220000_creative_skeletons.sql) — one row per analyzed winner: source, dedup_key (AdLibrary ad_key, unique per workspace+source), advertiser, image_url, media_type, format, framework, the four slots (hook/mechanism_claim/proof/offer), plus days_running, heat, first_seen/last_seen/resume_advertising, seed_keyword/seed_kind, status, raw.

**RLS:** member-read + service-write. Structure + image link only; never a lifted asset.

### Phase 2 — Discovery (AdLibrary.com)
[[../libraries/adlibrary]] — `searchAds({ keyword, appType:'3', geo:['USA'], daysBack, pageSize })` sends Bearer key; `fetchCreative(url)` fetches bytes; `isLongRunner()` filters (days_count + resume flag); `classifyMedia()` routes static vs video.

Seed list: [[../tables/competitors]] (DB-driven approved brands) + `CATEGORY_SEEDS` (hardcoded category keywords: superfood/mushroom/adaptogen coffee, energy, anti-inflammatory, longevity, anti-aging, weight-loss, ashwagandha, greens). One `step.run` per seed with ~7s throttle (10/min AdLibrary cap).

Dedup by `ad_key` → never re-vision, never re-spend (re-runs are cheap).

### Phase 3 — Vision deconstruction
[[../libraries/creative-skeleton]] `visionDeconstruct()` + `ingestAd()`: fetch image (Bearer) → Claude vision (Opus) → `{ format, framework, hook, mechanism_claim, proof, offer }` → upsert [[../tables/creative_skeletons]]. Statics are visioned at ingestion (`status='analyzed'`); videos are routed aside (`status='video_pending'`, deferred to Phase 6).

Mandatory dedup by `ad_key` before any vision spend.

### Phase 4 — Pattern matrix (the deliverable)
[[../libraries/creative-skeleton]] `buildPatternMatrix()` — clusters each slot's values across rows (greedy token-overlap, Jaccard ≥ 0.34) and keeps clusters spanning ≥N **independent brands** (distinct `advertiser`). Brand count is the score; longevity is tiebreak. Deterministic, no per-load LLM spend.

Emits: ranked `testMatrix` (hook × mechanism × proof × offer combos scored by summed cross-brand repetition, top 25) — the consumable hand-off for variant generation.

### Phase 5 — Surface + workflow
Dashboard `/dashboard/marketing/ads/winning`:
- **Browse tab** — deconstructed winners with shortlist/archive. Display via authenticated proxy (no re-hosting).
- **Pattern matrix tab** — slot patterns + supporting brands + test matrix ranked by score.
- "Run sweep now" button fires the manual event.

Cron + manual sweep:
- **Daily cron** `creative-finder-daily-cron` (0 9 * * * + event `ads/creative-finder.sweep`)
  - Per workspace: load seed list → sweep each seed → dedup by `ad_key` → ingest
  - After sweep: `promoteFromCategorySweep()` surfaces heavy advertisers (≥3 ads in sweep output) as `status='proposed'` competitors for owner approval
- **Manual event** `ads/creative-finder.sweep` — fires from the dashboard button; same sweep logic scoped to a workspace if supplied

API endpoints:
- `GET /api/ads/creative-finder` — list skeletons
- `POST /api/ads/creative-finder` — manual sweep
- `GET /api/ads/creative-finder/patterns` — pattern matrix
- `PATCH /api/ads/creative-finder/[id]` — shortlist (status toggle)
- `GET /api/ads/creative-finder/media?u=…` — authenticated proxy (Bearer-keyed)

### Phase 6 — Video (follow-on, deferred)
Routed via `status='video_pending'` at ingestion; deferred to [[../specs/creative-finder-video]]. Video pipeline drains backlog per workspace, downloads → ffmpeg keyframes + Whisper transcript → same four-slot skeleton, flips to `analyzed`/`failed`. See [[creative-finder-video]] + [[../libraries/video-skeleton]].

## Status / open work (2026-07-02)

**Shipped:** All five phases (static discovery + vision deconstruction + pattern matrix + surface + daily sweep). Browse tab shows deconstructed winners + shortlist; Pattern matrix tab shows slot patterns + supporting brands + ranked test matrix. Manual "Run sweep now" and daily cron both working. Dedup by `ad_key` and per-seed failures swallowed so one bad keyword doesn't fail the sweep. Cross-brand-repetition signal over ≥N independent brands mines the patterns (not heat/longevity alone). **AdLibrary search freshness gate** (Phase 2 of [[../specs/adlibrary-search-freshness-gate]]) live: per-seed last-searched tracking + 7-day skip window to minimize monthly quota burn (~67% → precise), with force-bypass for manual sweeps.

**Shipped and verified:**
- Discovery from AdLibrary (searchAds + fetchCreative + isLongRunner) ✓
- Vision deconstruction into four-slot skeleton (Opus + defensive parsing) ✓
- Idempotent upsert by `(workspace_id, source, dedup_key)` ✓
- Dashboard Browse + Pattern matrix tabs ✓
- Daily cron (9:00 UTC) + manual "Run sweep now" button ✓
- Pattern matrix clustering (greedy token-overlap, brand count = score) ✓
- Authenticated proxy for creative display (no re-hosting) ✓
- Shortlist toggle (PATCH → status='shortlisted') ✓
- Competitor promotion from category sweep (proposed → owner approval) ✓
- **AdLibrary freshness gate** — per-seed last-searched tracking (`adlibrary_searches` table), 7-day skip window (env-configurable), auto-skip on cron, force-bypass on manual sweep ✓

**Known gaps / not yet shipped:**
- Phase 6 (video deconstruction) — deferred to [[creative-finder-video]], backlog at `status='video_pending'` ✓

**Recent activity:**
- 2026-07-02: AdLibrary search freshness gate (spec [[../specs/adlibrary-search-freshness-gate]]) shipped and verified; folded into brain
- 2026-06-26: Specification shipped and verified; all phases (1–5) live in production
- Phase 6 (video) split to creative-finder-video (2026-06-23 board grooming)

**Open questions:** None

## Related

[[../specs/winning-static-creative-finder]] · [[../specs/creative-finder-video]] · [[../specs/ad-creative-scout]] · [[../specs/competitor-scout]] · [[../specs/landing-page-scout]] · [[ad-static]] · [[ad-publish]] · [[ad-render]] · [[advertorial-landers]] · [[../tables/creative_skeletons]] · [[../tables/competitors]] · [[../integrations/adlibrary]] · [[../integrations/anthropic]] · [[../inngest/creative-finder]] · [[../libraries/adlibrary]] · [[../libraries/creative-skeleton]] · [[../libraries/ads__customer-voice-mining]] · [[../libraries/competitors]] · [[../libraries/video-skeleton]] · [[../libraries/ad-gap]] · [[../functions/growth]] · [[../README]]
