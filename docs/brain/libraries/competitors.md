# `src/lib/competitors.ts` — Competitor Scout

Owns the DB-driven [[../tables/competitors]] set (M1 of [[../goals/acquisition-research-engine]]). The discovery half identifies + ranks competitors with evidence; the read half feeds the creative-finder sweep. North-star: writes `status='proposed'` only — the owner approves before anything enters the live sweep. See [[../specs/competitor-scout]].

## Exports

| Export | Notes |
|---|---|
| `loadApprovedCompetitorSeeds(workspaceId)` | → `Seed[]` — the sweep read path. ONLY `status='approved'` rows, as `{ keyword: search_keyword ?? brand, kind: 'competitor', note }`. Whitelisted-page rows use the EXACT page name (verbatim); everything else falls back to `brand`. Empty ⇒ zero competitor pulls (no hardcoded fallback). |
| `discoverCompetitors(workspaceId, productId)` | LLM ([[ai-models]] `OPUS_MODEL`) + web search proposes the competitive set framed by product intelligence; inserts `source='llm'`, `status='proposed'` with brand/domain/pdp_urls/evidence. → `{ proposed, skippedExisting, candidates }`. |
| `promoteFromCategorySweep(workspaceId, minAds=3)` | Scans [[../tables/creative_skeletons]] for advertisers recurring ≥`minAds` times; proposes the new ones as `source='category_sweep'`. → `{ promoted, skippedExisting, scanned }`. |
| `promoteWhitelistedPages(workspaceId, { minAds=3, minShare=0.5 })` | Scans [[../tables/creative_skeletons]] for advertiser pages whose ads point at a KNOWN approved-competitor `destination_domain`; proposes each recurring page (≥`minAds` ads, ≥`minShare` share fronting known competitors) as `source='whitelisted'` with `search_keyword`=the raw page name and `runs_ads_for`=the fronted competitor id. → `{ promoted, skippedExisting, scanned }`. See [[../specs/whitelisted-page-auto-tracking]]. |
| `normalizeBrand(raw)` | lowercase, strip protocol/www/TLD/path/non-alphanumeric → the compact handle + dedup key. |
| `CompetitorRow` / `CompetitorSource` / `CompetitorStatus` / `DiscoverResult` / `PromoteResult` | types |

## How discovery works

`discoverCompetitors` loads the product's intelligence (`title`, `product_type`, `target_customer`, `tags`, `certifications`, `description` from [[../tables/products]]), builds a brief, and calls Anthropic with the `web_search` server tool (resuming through `pause_turn`, mirroring [[blog]]'s writer). The model returns a JSON array; each entry is normalized + deduped via `upsertCandidate` (insert only if the brand doesn't already exist in ANY status). Token spend is logged via [[ai-usage]] (`purpose: 'competitor-scout-discovery'`).

## Gotchas

- **Proposals never auto-approve.** All writers insert `status='proposed'`; only the owner surface flips to `approved`.
- **Dedup is by normalized `brand` across ALL statuses** — a rejected competitor won't be re-proposed (`upsertCandidate` returns false when any row exists). Whitelisted-page proposals use the same `normalizeBrand(display)` as the dedup key.
- **`brand` IS the AdLibrary search keyword for normal rows** — kept a compact lowercase handle so the sweep can search it directly. Whitelisted-page rows override this with `search_keyword` = the raw page name because the AdLibrary API matches page names literally (`"Holistic Health Finds"` → 59 ads vs the normalized `holistichealthfinds` → 0).
- **Whitelisted detection is join-key `destination_domain`** — `promoteWhitelistedPages` builds a known-competitor host set from (a) each approved competitor's `domain` and (b) hosts observed in `creative_skeletons.destination_domain` for rows whose `advertiser`/`seed_keyword` matches an approved brand (so subdomains like `learn.erthlabs.co` anchor to the erthlabs competitor). A page recurring ≥`minAds` times with ≥`minShare` of its ads pointing at a known host is a whitelisted candidate; the dominant fronted competitor becomes `runs_ads_for`.
- `ANTHROPIC_API_KEY` is read at call time; `discoverCompetitors` throws `product_not_found` for an unknown product.
- **Outage-resilient fetch.** `runDiscovery` classifies Anthropic failures through [[anthropic-retry]]: a network blip → `throwForAnthropicNetworkError` (`AnthropicDependencyError`, retried), a non-2xx → `throwForAnthropicStatus` (retryable 429/5xx retried, terminal 4xx → `NonRetriableError` fail-fast). Paired with `retries: OUTAGE_SPANNING_RETRIES` on [[../inngest/competitor-scout]], a real Anthropic outage parks-and-drains instead of surfacing as a Control Tower error.

## Callers

- [[../inngest/competitor-scout]] (`discoverCompetitors`).
- [[../inngest/creative-finder]] (`loadApprovedCompetitorSeeds`, `promoteFromCategorySweep`, `promoteWhitelistedPages`).
- [[../inngest/acquisition-research-cadence]] (`promoteFromCategorySweep`, `promoteWhitelistedPages`).
- `src/app/api/ads/competitors` (list/discover/approve-reject surface).

## Related
[[../tables/competitors]] · [[adlibrary]] · [[creative-skeleton]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]] · [[../inngest/competitor-scout]] · [[../specs/competitor-scout]] · [[../specs/ad-creative-scout]] · [[../specs/landing-page-scout]]
