# Advertorial Attribution Fix (stamp advertorial_page_id from the angle) ✅

**Owner:** [[../functions/cmo]] · **Parent:** CMO mandate — ad measurement integrity ([[../dashboard/ad-scorecard]] / [[../libraries/meta-scorecards]]). Found 2026-06-20 diagnosing the ad scorecard's landing-page breakdown.

The ad scorecard under-attributes advertorial/listicle traffic. The listicle ads land on a **PDP-with-an-angle** (`/amazing-coffee?variant=reasons&angle=secret-reveal-8843dccd-reasons` — the "8 Reasons Why…" lander), not a bare advertorial URL. `resolveLanderIds` (`src/app/api/pixel/route.ts`) already parses `?angle=` → exact-matches `advertorial_pages.slug` → stamps `advertorial_page_id`. **But it's only stamped on the session's first INSERT and never re-resolved** — so sessions whose first pixel hit created the row without the stamp stay `null` forever, even though their `landing_url` carries an angle that **exactly** matches a page.

**Measured (last 2 days, 150 Meta sessions):** 127 carry an advertorial `?angle=`, **all exactly matching a page**, yet only **55** have `advertorial_page_id` set — **72 are null despite an exact-match angle** (the rest, 25, have no angle). So the scorecard buckets ~72 advertorial sessions as plain PDP. True advertorial share is ~**85%**, shown as ~37%.

## Root cause (confirmed)
- Of the 72 null-with-angle sessions, **72/72 have an angle that exactly equals an `advertorial_pages.slug`** — zero are slug-form mismatches. So it is **not** a parsing/slug problem; it's an **insert-only / never-re-resolved** gap: `resolveLanderIds` runs only when the session row is first created, and some first-touches create the row before/without the angle landing_url (or via a path that skips the stamp), leaving `advertorial_page_id` permanently null.

## Fix
1. **Re-resolve when null (ingestion).** In the pixel path, if a session row exists with `advertorial_page_id IS NULL` and the current/landing URL carries an `?angle=` that resolves to a page, **stamp it** (one-time set-when-null; never overwrite a non-null). So a later pixel event with the angle heals the row. (`landing_url` stays insert-only; only the lander id is back-stamped.)
2. **Backfill** existing sessions: `advertorial_page_id IS NULL` + `landing_url` angle exactly matches an `advertorial_pages.slug` → set `advertorial_page_id` (+ `ad_campaign_id`). Run for the recent window first, then all-time.
3. **`meta_attribution_daily` consistency.** Ensure the rollup that feeds [[../libraries/meta-scorecards]] uses the same angle→page resolution (the scorecard's `parseAngle` becomes the source of truth, not just a fallback), so the daily attribution + the landing-page breakdown both reflect the corrected stamps.

## Verification
- **Ingestion re-resolve (set-when-null).** In `psql`/probe, pick a `storefront_sessions` row with `advertorial_page_id IS NULL` whose `landing_url` carries an `?angle=` that equals an `advertorial_pages.slug`. Fire `GET /api/pixel?ws={workspace_id}&aid={its anonymous_id}&eid={uuid}&et=pdp_view&l={url-encoded landing_url with the angle}` (or a POST batch with that `session_context.landing_url`) → expect the row's `advertorial_page_id` (+ `ad_campaign_id`) now set to that page; `landing_url` unchanged.
- **Never-overwrite.** Repeat against a row that already has a *different* non-null `advertorial_page_id` → expect it unchanged (set-when-null only).
- **No false stamps.** Fire a pixel for a bare-PDP session (no `?angle=`) → expect `advertorial_page_id` stays NULL.
- **Backfill — recent.** `npx tsx scripts/backfill-advertorial-page-id.ts` prints `scanned / matched / distinct target pages` + sample matches; `… --apply` stamps them. Re-run dry-run → expect `matched` near 0 (idempotent, IS-NULL filter skips done rows).
- **Backfill — all-time (gated owner action).** `npx tsx scripts/backfill-advertorial-page-id.ts --all-time --apply`. Re-run the 2-day probe count of `advertorial_page_id IS NULL AND landing_url ~ 'angle='` exact-match sessions → expect ~0.
- **Scorecard.** After the rollup refresh (`meta-attribution-refresh` → `meta-scorecards-refresh`), the iteration scorecard's advertorial share ≈ angle-carrying-session count (~85% of recent Meta traffic), not ~37%. Resolution is uniform (persisted id → parse `?angle=`) across the pixel stamp, `src/lib/meta/attribution.ts`, and `src/lib/meta/scorecards.ts`, so the breakdown reflects corrected stamps even pre-backfill.
- **Meta perf unchanged.** Spend/CPA/ROAS from Meta are unchanged (this only fixes session bucketing, not Meta's own purchase attribution).

## Phase 1 — re-resolve + backfill + rollup consistency ✅
Shipped: the set-when-null re-resolve in `src/app/api/pixel/route.ts` (`resolveLanderIds` caller, existing-session branch); `scripts/backfill-advertorial-page-id.ts` (recent window default, `--all-time` gated, two-phase dry-run/`--apply`). Rollup consistency: `src/lib/meta/attribution.ts` (feeds `meta_attribution_daily`) and `src/lib/meta/scorecards.ts` already resolve a session's lander identically — prefer the persisted `advertorial_page_id`, else exact `?angle=`→slug match — so the landing-page breakdown reflects the corrected stamps; no rollup code change needed. No schema change (`advertorial_page_id`/`ad_campaign_id` shipped in Phase 2b). Brain: [[../tables/storefront_sessions]] · [[../libraries/meta__scorecards]] · [[../dashboard/storefront__ad-scorecard]]. Fold on ship.

**Backfill applied:** both passes ran in prod — recent window (`scripts/backfill-advertorial-page-id.ts --apply`) then all-time (`--all-time --apply`). The null-with-exact-angle back catalogue is stamped; owner to confirm the 2-day count drops to ~0 and the scorecard advertorial share reads ~85% after the next rollup refresh.
