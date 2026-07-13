# Analytics → Ad Testing (`/dashboard/analytics/ad-testing`)

Owner-only, **read-only** page: the per-**test** funnel across every hero product, grouped by **product** (badged with its **ad account**), sorted **crowning-potential → early dud**. The visual companion to the [[../../.claude/skills/ad-testing-results/SKILL.md|/ad-testing-results]] skill — same SDK, same numbers.

## What it shows

- One row per test (ad set): a **clickable creative thumbnail**, the verdict tier (👑 Crown / 📈 Promising / ⏳ Testing / 💀 Dud), live/paused, and the funnel — **CPM · spend · CTR · ATC · $/ATC · sales · CAC**.
- Clicking the thumbnail opens a **modal**: the full creative image, headline, primary text, description, destination link, and the funnel strip.
- **Structure issues** banner (a campaign serving >1 product; a cohort with no product mapping) + per-product `>4 active tests` flags.
- A **data-freshness** footer per test account (how long ago the 2h cron last refreshed it).

## Data path

`GET /api/workspaces/[id]/analytics/ad-testing` → [[../libraries/testing-results-sdk]] `getTestingResults` (numbers, from [[../tables/meta_insights_daily]] kept fresh by [[../inngest/media-buyer-test-cadence]]) then `enrichWithMetaCreatives` overlays the **live Meta creative** (thumbnail + current copy) on ACTIVE tests only (bounds the Graph fan-out). Auth: Supabase session; owner-gated in the sidebar (`ownerOnly`). READ-ONLY — never mutates an ad.

## Related

[[../libraries/testing-results-sdk]] · [[../../.claude/skills/ad-testing-results/SKILL.md]] · [[analytics-roas|Analytics → ROAS]] · [[../tables/media_buyer_test_cohorts]] · [[../inngest/media-buyer-test-cadence]] · [[../functions/growth]]
