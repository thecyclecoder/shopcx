# Winning Static-Creative Finder ⏳

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Static-ad optimization"

Continuously source **proven winning static ad creative** — from **competitors / the health-&-wellness category** (the real signal) and from **our own** top performers — into an **ideas bin**, so the team always has a pipeline of references to turn into more killer statics. First concrete spec under Growth's static-ad-optimization mandate; feeds the variant-generation specs after it.

## Source feasibility (tested 2026-06-19)
- ✅ **AdLibrary.com API — TESTED, works, no KYC. This is the external source.** `POST https://adlibrary.com/api/search`, `Authorization: Bearer ${ADLIBRARY_API_KEY}` (Business plan; key in `.env.local` + Vercel env). Body: `{ keyword, appType:"3" (e-commerce), geo:["USA"], daysBack, pageSize }`. Per-ad returns: creative (`preview_img_url`, `resource_urls[].image_url`), copy (`title`/`body`), advertiser (`advertiser_name`, `ecom_advertiser_id` = domain), and **winning signals** — scale (`all_exposure_value`, `impression`, `heat`, `new_week_exposure_value`) + longevity (`first_seen`, `last_seen`, `days_count`, `resume_advertising_flag`). Costs **1 credit/search**, **10/min, 10k/day**. Covers 7 networks → filter `platform` to Meta + image statics. (Quirk: `total` may read `0` while `results` is populated — page off `results`.)
- ✅ **Our own ads** — `meta_campaigns/adsets/ads/insights_daily` ([[storefront-iteration-engine]]); we have spend/ROAS/longevity → a true winner signal.
- ⛔ **Meta Ad Library API (`ads_archive`)** — blocked: requires the `facebook.com/ID` identity confirmation (verified — app + user token both `code 10 / 2332002`; it's a blanket API gate, not political-ads-specific, and not an app-permission). Becomes a *free* alternative only if the owner completes that KYC. AdLibrary.com is the path until/unless that's done.

## Phase 1 — Ideas bin + ingestion model ⏳
- ⏳ `creative_ideas` table — card: `source` (`adlibrary | own | manual`), `image_url` (ref/screenshot, never a lifted asset), `advertiser`, `headline/body`, `why_it_won` (signal + value), `dedup_key` (AdLibrary `ad_key`), `first_seen`/`days_running`, `tags`, `status` (`new | shortlisted | in_production | shipped`). Migration via [[write-migration]].
- ⏳ A source-agnostic `addIdea()` so AdLibrary / own / manual all land in the same shape.

## Phase 2 — External discovery (AdLibrary.com — primary) ⏳
- ⏳ `src/lib/adlibrary.ts` adapter — `searchAds({ keyword, daysBack, pageSize })` → the POST above. Sweep by (a) **category keywords** (greens powder, collagen, gut health, mushroom coffee, electrolytes, …) and (b) **competitor domains** (`ecom_advertiser_id`).
- ⏳ Filter to **Meta image statics** (`platform` ~ facebook/instagram; image creative present; skip video). Rank by a **winning score** = scale (`all_exposure_value`/`heat`) × longevity (`last_seen − first_seen` days, `resume_advertising_flag`). Top N → `creative_ideas` (`source='adlibrary'`, `why_it_won` = "running {days_count}d · exposure {heat}").
- ⏳ Scheduled sweep (daily Inngest) within credit limits (dedup by `ad_key`; cache so a re-seen ad doesn't burn a credit/duplicate).

## Phase 3 — Surface + workflow ⏳
- ⏳ Dashboard **Ideas bin** — browse / filter (source, tag, days-running, advertiser) / shortlist / promote to production. Sort by the winning score.
- ⏳ Hook for the next mandate spec (variant generation) to pull from `shortlisted`.

## Safety / invariants
- **External creative is reference/inspiration, never lifted** — store the concept + image link for analysis; never republish a competitor's asset.
- **Secrets:** `ADLIBRARY_API_KEY` lives in env (`.env.local` dev + Vercel), never committed. Respect rate limits (10/min, 10k/day) + credits.
- Own = real ROAS; external = scale+longevity signal (no true spend) — don't conflate.
- No-orphan: owner = [[../functions/growth]], parent = the static-ad-optimization mandate.

## Completion criteria
- A daily sweep lands ranked competitor + category winning statics (AdLibrary) in the ideas bin, deduped, with image + why-it-won.
- Our own winners auto-added (ROAS+longevity).
- Browsable/shortlistable/promotable from the dashboard; the bin feeds variant-generation.

## Related
[[storefront-iteration-engine]] · [[killer-statics]] · [[advertorial-landers]] · [[../functions/growth]] · [[../integrations/meta]]
