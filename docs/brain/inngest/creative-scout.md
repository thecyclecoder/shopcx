# inngest/creative-scout

The **deliberate per-product Creative Scout** — the imitate feed for the imitate→innovate loop (CEO 2026-07-12). Replaces the retired workspace-wide `creative-finder` sweep. For each of our products that has ≥1 APPROVED competitor (`competitors.product_id`), it pulls that product's competitors' long-running ads from AdLibrary, vision-deconstructs the statics into [[../tables/creative_skeletons]] **tagged with `competitor_id` + `product_id`**, and parks videos for the [[creative-finder]] video pipeline. Dahlia's `getProvenCompetitorAngles(productId)` ([[../libraries/creative-sourcing]]) then reads exactly that product's shelf — **a product imitates only the competitors WE chose for it**, not a workspace-wide soup.

**File:** `src/lib/inngest/creative-scout.ts`

## Why per-product (the base-layer fix)

Before this, [[../libraries/creative-agent]] `stockProduct` sourced competitor angles by a `coffee/weight` niche SUBSTRING match on advertiser/hook — deliberate per-product competitors never drove imitate at all. And the old sweep pulled ALL competitors + `CATEGORY_SEEDS` at once, risking AdLibrary's 10-searches/min cap. The scout fixes both:

- **Per-PRODUCT cadence.** It iterates product-by-product; each product's ~5 competitors is one small batch, 7s throttle between searches → every run stays far under the rate cap. The manual event takes an optional `productId` so ONE product can be scouted on demand (Dylan's requirement — "the scout should be able to be ran on a per product basis").
- **Deliberate tagging.** Every ingested skeleton carries `competitor_id` (the approved `competitors.id`) + `product_id` (the product that competitor was chosen for), threaded from the seed through [[../libraries/creative-skeleton]] `ingestAd`.

## Fully deliberate — what was DROPPED

Category auto-discovery is gone. No `CATEGORY_SEEDS`, no `promoteFromCategorySweep` (heavy advertisers recurring in category sweeps → 'proposed' competitors). Competitors are chosen by hand (`discoverCompetitors` proposals + manual approval). See [[../operational-rules]] § North star — a deliberate, supervisable set beats a proxy-optimized auto-discovery.

## What was PRESERVED

The two adjacent per-workspace side-effects the old sweep fed, both keyed off APPROVED competitors (so they survive the deliberate cut), run once per workspace after its products are swept:
- `promoteWhitelistedPages` — affiliate/advertorial pages fronting a KNOWN competitor (domain join) → 'proposed' whitelisted rows.
- `syncResearchUrlsFromCreatives` — Rhea's URL sensor upserts one `research_urls` row per distinct destination.

The heavier **video drain** stays in [[creative-finder]] (`creativeFinderVideoProcess`, cron `30 9 * * *`) — the scout parks videos as `video_pending` (product-tagged); that function downloads → ffmpeg keyframes + Whisper → the four-slot skeleton, tags preserved.

## Functions

### `creativeScoutWeeklyCron`
- **id** `creative-scout-weekly-cron` · **cron** `0 9 * * 1` (Mon 9am) · retries 1.
- For every ad-tool workspace (has `ad_campaigns` rows), sweep every product with approved competitors, then the per-workspace side-effects. Emits a Control Tower heartbeat (`creative-scout-weekly-cron`).

### `creativeScoutManualSweep`
- **id** `creative-scout-manual-sweep` · **event** `ads/creative-scout.sweep` · retries 1.
- Data `{ workspaceId?, productId?, force? }`. `workspaceId` scopes to one tenant; `productId` scopes to ONE product (the per-product on-demand path); `force=true` bypasses the freshness gate (explicit spend). Fired by `POST /api/ads/creative-finder` (the dashboard "Run sweep now" button, now scout-backed).

## The sweep, per product

1. `loadApprovedCompetitorsForProduct(workspaceId, productId)` ([[../libraries/competitors]]) → Seeds carrying `competitorId` + `productId`. `search_keyword` (exact page/brand name the API matches literally) wins over `brand`.
2. Freshness gate (unless `force`): `filterSeedsByFreshness` drops brands searched inside `adlibraryFreshnessDays()` (default 7). A fresh/never-searched brand always passes → a newly-approved competitor runs on the very next scout.
3. Per kept seed: `safeSweep` → `sweepCompetitorLanes` (winners-flow, [[../libraries/creative-skeleton]] + [[../libraries/adlibrary-winners]]) → routes the competitor to a collection LANE (below) → `ingestAd` (statics vision-deconstructed + `status='analyzed'`). 7s `step.sleep` between seeds. A seed that resolves to NEITHER lane is logged as a **bad seed** (its `search_keyword`/`domain` don't map to a Meta advertiser — a reliable fix-me signal).

## Two-lane collection + longitudinal tracking (winners-flow, 2026-07-17)

The old keyword `searchAds` path (`sweepSeed`) only returned a brand's RECENT ads, never its proven long-runners. `sweepCompetitorLanes` calls `resolveAdvertiser(seed.keyword, { domain: seed.expectedDomain })` and routes:

- **LANE A — `via:'name'` → a Meta `pageId`.** `scanWinners(pageId)` (`POST /api/winners/advertiser/{pageId}`, 10 credits) scans the brand's **FULL library** (not recent-only), image-only.
- **LANE B — `via:'domain'`** (advertiser un-resolvable by name — an AdLibrary limitation — but a domain is known, e.g. Beam→shopbeam.com). `searchAds({ domain, adsType:['1'], platform:['facebook','instagram'] })` returns the brand's real ads (domain-search carries no page_id, so no winners scan).
- **`via:null`** — neither name nor domain resolves = a reliable **bad seed** (unlike the old "0 ads" false flag).

### The winner signal is OURS, not AdLibrary's

AdLibrary's `tier`/`composite` are **not trusted** — the winners scan returned `tier="loser"` for *every* major brand (AG1, MUD\WTR, Calm), and the composite just tracked a mis-parsed recency number (day-counts of 1–6, `first_seen` parsing as 1970). Instead the scout tracks **longitudinal persistence** through `collectAndTrack`, per competitor:

- **NEW static** (ad_key we don't have) → `ingestAd`: OUR four-slot vision + `concept_tags` (both lanes, one schema), and the longitudinal clock starts (`our_first_seen=now`, `winner_tier='new'`). Capped by `visionCap` (Opus spend); AdLibrary's composite only ORDERS which new ads to vision first.
- **ALREADY-SEEN** → `reobserveAd`: cheap bump of `our_last_seen` + `observed_sweeps`, recompute `winner_score` = persistence days + `winner_tier` (`new`<7d, `building`≥7d, `proven`≥21d). **No re-vision.**
- **VANISHED** (this competitor's active rows not in the sweep) → `markDisappearedAds`: `still_active=false`, `winner_tier='retired'` — the competitor stopped paying to run it.

An ad a competitor keeps running across our weekly sweeps IS a proven winner (they pay because it converts) — the strongest signal, fully ours, no dependence on AdLibrary's opaque score.

Advertiser resolution is STRICT (`nameMatches`: normalized-equal or brand + one corporate suffix) — the loose matcher mis-picked "Bulletproof Automotive"/"Ryze Hendricks"/"…Concrete Beams". Unit-tested in `src/lib/adlibrary-winners.test.ts`. The legacy `adMatchesCompetitor` domain/advertiser relevance filter (`src/lib/adlibrary.test.ts`) still guards the `sweepSeed` fallback path.

## LANE A winners-empty fallback (2026-07-19)

Direct-API probes showed the winners endpoint (`/api/winners/advertiser/{pageId}`) returns 0 concepts for MOST approved competitors (NativePath, Vital Proteins — both scans empty) while the plain keyword/domain `searchAds` returns 30-60 live static ads for the same brand. Obvi only squeaked through because its winners count was 3 (of which 1 ingested). So a scout that only consumes winners starved the skeleton library for exactly the brands that advertise the most.

`sweepCompetitorLanes` now falls back when `scanWinners` is empty (spec: `WINNERS_FALLBACK_THRESHOLD=1`):

1. **LANE A resolves + winners populated** (`scanWinners` ≥ 1 static) → `source='winners'` (the preferred path — proven long-runners, ordered by AdLibrary composite). No fallback searchAds fires.
2. **Winners empty → keyword fallback.** `searchAds({ keyword: seed.keyword, adsType: ['1'], platform: ['facebook','instagram'], geo: ['USA'], pageSize: 50 })`. If ≥ 1 static → `source='keyword'` — the ingest goes through the SAME approved-advertiser-guarded, static-only, dedup path (`collectAndTrack`) as the winners lane.
3. **Winners empty AND keyword empty AND `opts.domain` is set → domain fallback.** `searchAds({ domain, adsType: ['1'], platform: ['facebook','instagram'], geo: ['USA'], pageSize: 50 })`. If ≥ 1 static → `source='domain'`.
4. **All three empty (or keyword empty + no domain)** → `transientEmptyPull=true`, `source=null`, no retire. The competitor's existing skeletons stay untouched — a single empty pull could be an AdLibrary dip and must never wipe the library.

**Every fallback preserves the invariants** the winners lane already respects: the approved-advertiser guard drops non-mapped affiliates (Creamer's "Healthy Habits" / "A Path to Better Health"), static-only, dedup by `dedup_key`, existing → `reobserveAd` (persistence++), new → `ingestAd` (vision, capped). Retire only fires when a lane produced a non-empty pull (so a fallback that DID find ads authoritatively retires the competitor's rows not in this pull, same as the winners lane).

`safeSweep` in `src/lib/inngest/creative-scout.ts` logs `source=<winners|keyword|domain|none>` per competitor so the operator can see which brands rely on the fallback. Fingerprint: NativePath / Vital Proteins should now show `LANE WINNERS · source=keyword` (or `domain`) — a resolved winners scan that fell through to searchAds.

Pinned by `src/lib/creative-skeleton.fallback.test.ts` — winners populated → source=winners (no fallback), winners empty → keyword fallback → source=keyword, winners+keyword empty + domain → source=domain, all empty → transientEmptyPull, non-mapped guard still fires under the fallback.

## Reliability guarantees (2026-07-19 — Creamer silent-drop / non-mapped-leakage fix)

Three defects reproduced live on Amazing Creamer (5 APPROVED competitors → only 2 yielded skeletons, plus 2 non-mapped advertisers leaked; a forced sweep inserted nothing). Fixed together so every approved competitor's winners land AND no affiliate/lookalike advertiser survives:

- **Approved-advertiser guard at persist time.** [[../libraries/creative-skeleton]] `filterAdsByApprovedAdvertisers(ads, approvedSet)` is invoked in `sweepCompetitorLanes` AFTER each lane's raw pull. `approvedSet` is the `normalizeBrand`-handle set of EVERY approved competitor of the product (built by `buildApprovedAdvertiserSet` in `src/lib/inngest/creative-scout.ts` from the full `loadApprovedCompetitorsForProduct` result, so freshness-skipped seeds still count). An ad whose `normalizeBrand(advertiser)` isn't in the set is DROPPED (`nonMappedDropped++`, never persisted) — this is what stops LANE-B affiliate leakage like Creamer's "Healthy Habits" / "A Path to Better Health". A null/blank advertiser drops (cannot verify → cannot admit). An empty set opts out (no per-product context → no guard).
- **No retire on a transient empty pull.** `sweepCompetitorLanes` returns early with `transientEmptyPull=true` if the raw pull returns 0 statics after a lane resolved. `markDisappearedAds` is NOT invoked in that case — a single empty pull is likely an AdLibrary dip or a cached blank body and must never wipe a competitor's existing skeletons. The operator sees a distinctive warn line (`resolved but AdLibrary returned 0 statics — TRANSIENT EMPTY PULL`) with the resolved brand name so a truly stopped brand is distinguishable from a transient dip across sweeps.
- **Silent-drop parser fix in `scanWinners`.** The old shape sniff (`trimmed.startsWith("{") && includes('"results"') && !includes("\n{")`) mis-routed cached JSON bodies whose nested arrays contained `\n{` to the NDJSON path, then every per-line JSON.parse threw and the parser returned `[]` — the Creamer silent-drop fingerprint for Obvi / NativePath / Vital Proteins. `parseScanWinnersBody` in [[../libraries/adlibrary-winners]] now tries JSON-first (single whole-body parse) and only falls through to NDJSON when that fails. Unit-tested against pretty-printed cached bodies + fresh NDJSON streams + blank bodies.

Per-competitor observability (`safeSweep` in `src/lib/inngest/creative-scout.ts`) surfaces `pulled → new + re-observed + retired + non-mapped-dropped` per brand PLUS a distinct WARN for a resolved-but-yielded-0 pull, so a silent drop is loud in the cron logs. Bad seeds (via:null) already logged a BAD SEED line.

Pinned by `src/lib/adlibrary-winners.test.ts` (`parseScanWinnersBody` shapes) + `src/lib/creative-scout.guard.test.ts` (approved-advertiser guard + `buildApprovedAdvertiserSet`).

## Gotchas

- **A product with zero approved competitors is silently skipped** — the scout does zero pulls for it (no hardcoded fallback). Approve a competitor row (with `product_id` set) to feed it.
- **Whitelisted rows need `product_id` to be scouted per-product.** `loadApprovedCompetitorsForProduct` filters on `product_id`; an approved `source='whitelisted'` row without one won't be swept. (Latent gap — the old workspace-wide read had no product filter. Set `product_id` on approval to include it.)
- **Video cover-frame ≠ static.** AdLibrary tags `media_type`; videos park as `video_pending`, never ingested as `analyzed` statics. When shortlisting a scouted skeleton for imitation, trust `media_type` — a video's cover frame is NOT a static ad.
- **Heartbeat id is stable.** `creative-finder-video-process` kept its id through the retire so Control Tower tracking is uninterrupted; the scout adds its own `creative-scout-weekly-cron` beat.

## Related

[[creative-finder]] · [[competitor-scout]] · [[acquisition-research-cadence]] · [[../tables/creative_skeletons]] · [[../tables/competitors]] · [[../libraries/competitors]] · [[../libraries/creative-skeleton]] · [[../libraries/creative-sourcing]] · [[../libraries/creative-agent]] · [[../lifecycles/ad-render]] · [[../operational-rules]]
