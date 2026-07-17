# `src/lib/adlibrary-winners.ts` — the WINNERS flow (advertiser resolution + winners scan)

The keyword `searchAds` ([[adlibrary]]) only returns a brand's RECENT ads — never its proven long-running winners. Those live behind AdLibrary's **advertiser** endpoints. This module owns the two steps that unlock them, plus the STRICT matcher that keeps the resolver from confidently picking a wrong page. Consumed by [[creative-skeleton]] `sweepCompetitorLanes` (the live scout path — [[../inngest/creative-scout]]). See [[../integrations/adlibrary]].

## The flow

1. `GET /api/advertisers/search?q={brand}` (**free**) → brand → Meta `pageId`.
2. `POST /api/winners/advertiser/{pageId}` (**10 credits**) → scan the FULL library → scored + concept-tagged winners.

## Exports

| Export | Notes |
|---|---|
| `resolveAdvertiser(brand, { domain? })` | → `AdvertiserResolution { pageId, name, likes, via }`. `via:'name'` (a strict name→pageId match, LANE A) · `via:'domain'` (no name match but a domain is known → LANE B, `pageId` null) · `via:null` (neither → bad seed). Never throws (a fetch failure → unresolved). |
| `scanWinners(pageId, { country?, topEnrich?, maxPages? })` | → `WinnerConcept[]`. Handles BOTH live response shapes: cached `{ results:[{ad,score}] }` JSON and a fresh NDJSON stream (`{_stage:'score', ad, score}`). Filters to `tags.format === 'static_image'` (image-only). |
| `pickBestCandidate(brand, candidates)` / `nameMatches(brand, candidateName)` | Pure ranker + STRICT matcher (exported for tests). |
| `AdvertiserResolution` / `WinnerConcept` | types |

## STRICT `nameMatches` — the anti-mispick rule

A candidate matches ONLY when their normalized forms are EQUAL, OR the candidate is the brand plus a single trailing corporate suffix (`llc`/`inc`/`co`/`corp`/`ltd`/`company`). Deliberately strict: the loose token/prefix matcher mis-picked **"Bulletproof Automotive"** for Bulletproof, **"Ryze Hendricks"** for RYZE, **"…Concrete Beams"** for Beam Dream, **"Live Update Pvt Ltd"** for Live it Up. `pickBestCandidate` then takes the **highest-likes** strict match (the MUD\WTR fix — `best_match` returned a bogus 0-like "Mud Wtr Wellness" over the real 124K-like page). A brand that doesn't strictly match is routed to the domain lane or left unresolved — a known gap beats a confidently-wrong Page ID feeding the (10-credit) winners scan. The operator's `search_keyword` should be the brand AS IT APPEARS on Meta.

## `WinnerConcept` shape

`{ ad, tier, composite, variantCount, tags }` where `tags = { angle, format, archetype, why_it_works, cialdini_lever, awareness_stage }`. `sweepCompetitorLanes` maps `tier`/`composite`/`tags` → the row's `winner_tier`/`winner_score`/`concept_tags` ([[../tables/creative_skeletons]]). LANE B's OUR-vision path (Phase 2c) emits the SAME `tags` schema so both lanes are uniform for Dahlia + Max.

## Gotchas

- **Domain search carries no `page_id`.** LANE-B advertisers genuinely don't resolve by name; a `domain:` search returns their ads but with no page id, so the winners endpoint isn't available for them — hence OUR vision produces the breakdown instead.
- **`scanWinners` is 10 credits (0 when cached).** The scout calls it once per LANE-A competitor; the 7s inter-seed sleep keeps it under AdLibrary's 10/min.
- **Meta-only by construction.** The winners endpoint is Meta-native and ignores `adsType`; the `static_image` tag filter drops video.

## Related
[[adlibrary]] · [[creative-skeleton]] · [[../inngest/creative-scout]] · [[../integrations/adlibrary]] · [[../tables/creative_skeletons]] · [[anthropic]] (LANE-B vision)
