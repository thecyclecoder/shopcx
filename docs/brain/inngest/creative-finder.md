# inngest/creative-finder

Daily sweep that pulls long-running competitor + category ads from [[../integrations/adlibrary]], vision-deconstructs each static into a skeleton, and routes videos aside for Phase 6. See [[../lifecycles/creative-finder]] · [[../specs/winning-static-creative-finder]].

**File:** `src/lib/inngest/creative-finder.ts`

## Functions

### `creative-finder-daily-cron`
- **Trigger:** cron `0 9 * * *`
- **Retries:** 1
- Gated on `hasAdLibraryKey()` → returns `{ skipped: "no_adlibrary_key" }` if unset.
- For each ad-tool workspace (distinct `ad_campaigns.workspace_id`), builds the seed list per workspace via `workspaceSeeds()` = **DB-driven approved competitors** ([[competitor-scout]] `loadApprovedCompetitorSeeds`) **+ `CATEGORY_SEEDS`** — competitor brands are no longer hardcoded.
- **Freshness gate** (Phase 2 of [[../specs/adlibrary-search-freshness-gate]]): between `workspaceSeeds` and the sweep loop, a `freshness-${workspaceId}` step runs [[../libraries/creative-skeleton]] `filterSeedsByFreshness(workspaceId, seeds, adlibraryFreshnessDays())` — reads [[../tables/adlibrary_searches]] and drops seeds whose `last_searched_at` is inside the window (default 7d, `ADLIBRARY_FRESHNESS_DAYS` env override) WITHOUT a `searchAds` call. A seed with **no ledger row** (a newly-approved competitor / whitelisted page) always passes → runs on the very next cron regardless of others being fresh. On a DB read error the gate is fail-open (returns all seeds — never silently starve the sweep). The skipped count surfaces in the run result + heartbeat as `skipped`, plus `freshnessDays`.
- One `step.run` per remaining seed (`sweepSeed`) with a `step.sleep` ~7s `SWEEP_DELAY_MS` throttle (AdLibrary 10/min RATE cap — orthogonal to the freshness gate's monthly QUOTA cap; both stay on).
- After a workspace's sweep, a `promote-${workspaceId}` step runs `promoteFromCategorySweep()` — heavy advertisers that recurred (≥3 ads) in the sweep output surface as `status='proposed'` competitors for owner approval.
- A follow-up `promote-whitelisted-${workspaceId}` step runs `promoteWhitelistedPages()` — advertiser pages (affiliate/advertorial/creator personas) that drive to a KNOWN approved-competitor `destination_domain` surface as `source='whitelisted'`, `status='proposed'` rows with `search_keyword` = the exact page name + `runs_ads_for` = the fronted competitor. See [[../specs/whitelisted-page-auto-tracking]].

### `creative-finder-manual-sweep`
- **Trigger:** event `ads/creative-finder.sweep` `{ workspaceId?, force? }`
- **Retries:** 1
- Same sweep (incl. per-workspace `workspaceSeeds` + category-sweep promotion + whitelisted-page promotion); scoped to `workspaceId` when supplied (else all ad-tool workspaces). Fired by the dashboard "Run sweep now" button.
- **`force`** (Phase 2 of [[../specs/adlibrary-search-freshness-gate]]): `force=true` BYPASSES the freshness gate — explicit user action = intentional spend. Default respects it (parity with the cron), so re-clicking the button without `force` doesn't burn AdLibrary quota re-searching already-fresh seeds. Threaded from `POST /api/ads/creative-finder { workspaceId, force? }`.

### `creative-finder-video-process`
- **Trigger:** cron `30 9 * * *` (after the 9:00 static sweep) + event `ads/creative-finder.video` `{ workspaceId?, max? }`
- **Retries:** 1
- Phase 1 of [[../specs/creative-finder-video]]: drains each ad-tool workspace's `status='video_pending'` [[../tables/creative_skeletons]] backlog via [[../libraries/video-skeleton]] `processVideoPending` (download → ffmpeg keyframes + Whisper transcript → same four-slot skeleton; hook = opening frame + first spoken line). Each row flips to `analyzed`/`failed` → cost-bounded (no re-process).
- **Gated** on `hasAdLibraryKey()` (download) + `hasFfmpeg()` (frames) → `{ skipped: "no_adlibrary_key" | "no_ffmpeg" }`; transcription is best-effort inside the pipeline (`hasOpenAiKey()`). Emits a Control-Tower heartbeat. Returns `{ workspaces, totals: { pending, analyzed, failed, bytesDownloaded, whisperCents } }`. Fired on demand by POST `/api/ads/creative-finder { mode:"video" }`.

## Downstream events sent

_None._

## Tables written

- [[../tables/creative_skeletons]] (via [[../libraries/creative-skeleton]] `ingestAd` — idempotent upsert; now stores the **complete AdLibrary payload** per ad — destination domain, copy, CTA, spend, engagement, channel — see [[../specs/ad-creative-scout]]). `creative-finder-video-process` **updates** `video_pending` rows → `analyzed` with the four-slot skeleton (via [[../libraries/video-skeleton]]).
- [[../tables/competitors]] (`promoteFromCategorySweep` inserts `source='category_sweep'` candidates; `promoteWhitelistedPages` inserts `source='whitelisted'` candidates with `search_keyword` + `runs_ads_for` — all `status='proposed'`)
- `ai_token_usage` (vision usage — statics `creative_skeleton_vision`, video `creative_skeleton_video_vision` — via [[../libraries/ai-usage]])

## Tables read (not written)

- [[../tables/ad_campaigns]] (which workspaces use the ad tool)
- [[../tables/competitors]] (approved competitor brands → sweep seeds, via [[../libraries/competitors]] `loadApprovedCompetitorSeeds`)
- [[../tables/creative_skeletons]] (dedup by `ad_key`; category-sweep promotion reads `advertiser`; whitelisted-page promotion reads `advertiser` + `destination_domain` + `seed_keyword`)
- [[../tables/adlibrary_searches]] (Phase 2 freshness gate reads `(workspace_id, keyword, last_searched_at)`; [[../libraries/creative-skeleton]] `sweepSeed` best-effort UPSERTs the same row after every `searchAds` return)

## Gotchas

- **Dedup + throttle + freshness gate** keep credit/vision spend bounded — re-runs are cheap (already-seen `ad_key`s skipped, and same-week seeds skip the `searchAds` call entirely).
- Per-seed failures are swallowed (`safeSweep`) so one bad keyword doesn't fail the sweep; counts surface in the return value.
- **Freshness gate is fail-open.** A DB read error in `filterSeedsByFreshness` logs + returns all seeds — the sweep still runs (over-search is safer than under-search when the ledger is broken). Same rule at the writer: a failed `adlibrary_searches` UPSERT never fails `sweepSeed`.

---

[[../README]] · [[../integrations/adlibrary]] · [[../integrations/openai]] · [[../libraries/creative-skeleton]] · [[../libraries/video-skeleton]] · [[../libraries/ad-transcribe]] · [[../libraries/adlibrary]] · [[../libraries/ad-gap]] · [[../libraries/competitors]] · [[../tables/competitors]] · [[../tables/adlibrary_searches]] · [[competitor-scout]] · [[../specs/ad-creative-scout]] · [[../specs/winning-static-creative-finder]] · [[../specs/creative-finder-video]] · [[../specs/competitor-scout]] · [[../specs/adlibrary-search-freshness-gate]] · [[../../CLAUDE]]
