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

## Phase 1 — DB-fed sweep + full-payload capture + ad-gap recommendations ⏳
Expand the AdLibrary parse + `creative_skeletons` (or a new `competitor_ads` record) to store the complete payload incl. `ecom_advertiser_id`/store domain + copy + spend + longevity + engagement; point the sweep at the `competitors` table; add the gap-analysis pass → recommendations. Brain: [[../goals/acquisition-research-engine]] · [[competitor-scout]] · [[../integrations/adlibrary]] · [[../libraries/adlibrary]] · [[../inngest/creative-finder]] · [[../tables/creative_skeletons]] · [[landing-page-scout]].

## Verification
- A sweep run stores, per ad, the **destination domain** (`ecom_advertiser_id`), full copy, CTA, spend, longevity, engagement — not just the creative image; `creative_skeletons`/`competitor_ads` is non-empty for approved competitors.
- The gap layer surfaces concrete *"competitor X runs this angle/offer we don't"* recommendations with the supporting ad evidence.
- [[landing-page-scout]] can read the captured destination domains from this data.
- Negative: with no approved competitors, the sweep no-ops (no hardcoded list); a foreign/irrelevant advertiser isn't force-swept.
