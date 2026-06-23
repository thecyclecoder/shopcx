# Ad Creative Scout — DB-fed sweep + capture EVERYTHING + ad-gap layer ⏳

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] (M2)
**Blocked-by:** [[competitor-scout]]

Turn the existing creative finder ([[../specs/winning-static-creative-finder]], `creative-finder-daily-cron`) into the **Ad Creative Scout**: feed it the DB competitor set, get the prod sweep actually collecting, **capture the COMPLETE AdLibrary payload per ad** (we currently discard most of it), and add a **gap-finding layer**.

## ⭐ Store EVERYTHING AdLibrary returns (verified — the data is rich)
Our parser keeps ~3 fields; a raw AdLibrary row also carries the **destination** (`ecom_advertiser_id` = store domain per ad — e.g. `shop.ryzesuperfoods.com`; `has_store_url`), `call_to_action`, **full copy** (`title`/`body`/`message`), **spend/longevity** (`estimated_spend`, `days_count`, `first_seen`/`last_seen`, `all_exposure_value`/`heat`/`impression`), **engagement** (`like`/`comment`/`share`/`view` counts), `platform`, `fb_merge_channel`, `ads_type`. **Capture all of it** into an expanded ad record — it powers ad-gap analysis AND is the **bridge to [[landing-page-scout]]** (the destination domains are where competitors send paid traffic).

## What it does
- **Read competitors from the DB** ([[competitor-scout]]'s table), not hardcoded `COMPETITOR_SEEDS`.
- **Get the sweep collecting in prod** (`creative_skeletons` is currently empty — confirm `ADLIBRARY_API_KEY` in Vercel + the cron runs for ad-tool workspaces).
- **Gap-finding layer:** compare competitors' winning angles/formats/offers/CTAs (from the captured copy + spend + longevity) against ours → surface *"angles competitors run that we don't"* as recommendations into the ad iteration engine ([[../specs/storefront-iteration-engine]]).

## Phase 1 — DB-fed sweep + full-payload capture + ad-gap recommendations 🚧
Expand the AdLibrary parse + `creative_skeletons` (or a new `competitor_ads` record) to store the complete payload incl. `ecom_advertiser_id`/store domain + copy + spend + longevity + engagement; point the sweep at the `competitors` table; add the gap-analysis pass → recommendations. Brain: [[../goals/acquisition-research-engine]] · [[competitor-scout]] · [[../integrations/adlibrary]] · [[../libraries/adlibrary]] · [[../libraries/ad-gap]] · [[../inngest/creative-finder]] · [[../tables/creative_skeletons]] · [[landing-page-scout]].

### Status / open work
- ✅ **Full-payload capture** — `src/lib/adlibrary.ts` `normalize()` now keeps the complete AdLibrary row; `creative_skeletons` gained `destination_domain` (`ecom_advertiser_id`), `has_store_url`, `call_to_action`, `body`/`message`, `estimated_spend`/`all_exposure_value`/`impression`, `like/comment/share/view_count`, `platform`/`fb_merge_channel`/`ads_type` (migration `20260702120000_creative_skeletons_full_payload.sql`); `ingestAd` persists them.
- ✅ **DB-fed sweep** — already DB-driven via [[competitor-scout]] (`loadApprovedCompetitorSeeds`); no hardcoded list. No change needed.
- ✅ **Ad-gap layer** — `src/lib/ad-gap.ts` `buildAdGapReport()` clusters competitor winning angles, subtracts our active `product_ad_angles`, surfaces "competitor X runs this angle/offer we don't" recommendations with ad evidence (incl. `destination_domain`). Surfaced at `GET /api/ads/creative-finder/gaps`. Brain: [[../libraries/ad-gap]].
- ⏳ **Migration apply (gated)** — `npx tsx scripts/apply-creative-skeletons-full-payload-migration.ts` against the pooler (needs prod creds — owner-approved).
- ⏳ **Prod collection** — `creative_skeletons` empty in prod until `ADLIBRARY_API_KEY` is set in Vercel + the `creative-finder-daily-cron` runs for ad-tool workspaces (operational, not code). Verify a sweep populates the new columns before folding.

## Verification
- A sweep run stores, per ad, the **destination domain** (`ecom_advertiser_id`), full copy, CTA, spend, longevity, engagement — not just the creative image; `creative_skeletons`/`competitor_ads` is non-empty for approved competitors.
- The gap layer surfaces concrete *"competitor X runs this angle/offer we don't"* recommendations with the supporting ad evidence.
- [[landing-page-scout]] can read the captured destination domains from this data.
- Negative: with no approved competitors, the sweep no-ops (no hardcoded list); a foreign/irrelevant advertiser isn't force-swept.
