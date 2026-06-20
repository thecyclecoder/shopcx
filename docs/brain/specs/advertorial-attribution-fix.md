# Advertorial Attribution Fix (stamp advertorial_page_id from the angle) ⏳

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
- A Meta session landing on `/{handle}?angle={advertorial-slug}` whose first pixel row was created without the stamp → after the fix, a subsequent pixel hit (or the backfill) sets `advertorial_page_id`. Re-run the 2-day count: null-with-exact-angle drops to ~0.
- The ad scorecard's landing-page breakdown shows advertorial ≈ angle-carrying-session count (~85% of recent Meta traffic), not ~37%.
- A genuinely non-advertorial PDP visit (no angle) stays unattributed (no false advertorial stamps).
- Spend/CPA/ROAS from Meta are unchanged (this only fixes session bucketing, not Meta's own purchase attribution).

## Phase 1 — re-resolve + backfill + rollup consistency ⏳
The set-when-null re-resolve in `src/app/api/pixel/route.ts` (`resolveLanderIds` caller); the backfill; the `meta_attribution_daily`/scorecard resolution alignment. Brain: [[../tables/storefront_sessions]] · [[../libraries/meta-scorecards]] · [[../dashboard/ad-scorecard]]. Fold on ship.
