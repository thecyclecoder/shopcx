# `src/lib/competitors.ts` — Competitor Scout

Owns the DB-driven [[../tables/competitors]] set (M1 of [[../goals/acquisition-research-engine]]). The discovery half identifies + ranks competitors with evidence; the read half feeds the creative-finder sweep. North-star: writes `status='proposed'` only — the owner approves before anything enters the live sweep. See [[../specs/competitor-scout]].

## Exports

| Export | Notes |
|---|---|
| `loadApprovedCompetitorSeeds(workspaceId)` | → `Seed[]` — the sweep read path. ONLY `status='approved'` rows, as `{ keyword: brand, kind: 'competitor', note }`. Empty ⇒ zero competitor pulls (no hardcoded fallback). |
| `discoverCompetitors(workspaceId, productId)` | LLM ([[ai-models]] `OPUS_MODEL`) + web search proposes the competitive set framed by product intelligence; inserts `source='llm'`, `status='proposed'` with brand/domain/pdp_urls/evidence. → `{ proposed, skippedExisting, candidates }`. |
| `promoteFromCategorySweep(workspaceId, minAds=3)` | Scans [[../tables/creative_skeletons]] for advertisers recurring ≥`minAds` times; proposes the new ones as `source='category_sweep'`. → `{ promoted, skippedExisting, scanned }`. |
| `normalizeBrand(raw)` | lowercase, strip protocol/www/TLD/path/non-alphanumeric → the compact handle + dedup key. |
| `CompetitorRow` / `CompetitorSource` / `CompetitorStatus` / `DiscoverResult` / `PromoteResult` | types |

## How discovery works

`discoverCompetitors` loads the product's intelligence (`title`, `product_type`, `target_customer`, `tags`, `certifications`, `description` from [[../tables/products]]), builds a brief, and calls Anthropic with the `web_search` server tool (resuming through `pause_turn`, mirroring [[blog]]'s writer). The model returns a JSON array; each entry is normalized + deduped via `upsertCandidate` (insert only if the brand doesn't already exist in ANY status). Token spend is logged via [[ai-usage]] (`purpose: 'competitor-scout-discovery'`).

## Gotchas

- **Proposals never auto-approve.** Both writers insert `status='proposed'`; only the owner surface flips to `approved`.
- **Dedup is by normalized `brand` across ALL statuses** — a rejected competitor won't be re-proposed (`upsertCandidate` returns false when any row exists).
- **`brand` IS the AdLibrary search keyword** — kept a compact lowercase handle so the sweep can search it directly.
- `ANTHROPIC_API_KEY` is read at call time; `discoverCompetitors` throws `product_not_found` for an unknown product.

## Callers

- [[../inngest/competitor-scout]] (`discoverCompetitors`).
- [[../inngest/creative-finder]] (`loadApprovedCompetitorSeeds`, `promoteFromCategorySweep`).
- `src/app/api/ads/competitors` (list/discover/approve-reject surface).

## Related
[[../tables/competitors]] · [[adlibrary]] · [[creative-skeleton]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]] · [[../inngest/competitor-scout]] · [[../specs/competitor-scout]] · [[../specs/ad-creative-scout]] · [[../specs/landing-page-scout]]
