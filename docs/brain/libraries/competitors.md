# `src/lib/competitors.ts` — Competitor Scout

Owns the DB-driven [[../tables/competitors]] set (M1 of [[../goals/acquisition-research-engine]]). The discovery half identifies + ranks competitors with evidence; the read half feeds the deliberate per-product [[../inngest/creative-scout]]. North-star: writes `status='proposed'` only — the owner approves before anything enters the live scout. See [[../specs/competitor-scout]].

## Exports

### SDK chokepoint (Phase 1 of [[../specs/competitor-sdk-chokepoint-and-per-product-cleanup]])

The single read/write surface for `public.competitors`. Enforced by
[scripts/_check-competitors-sdk-compliance.ts](../../../scripts/_check-competitors-sdk-compliance.ts) —
any `.from('competitors')` outside `src/lib/competitors.ts` fails the `predeploy` gate. See CLAUDE.md § Local conventions ("Raw `.from(...)` with no SDK → STOP").

| Export | Notes |
|---|---|
| `listCompetitors({workspaceId, productId?, status?, includeUnscoped?, limit?})` | → `CompetitorRow[]` — the single read path. Strict per-product when `productId` is set; `includeUnscoped: true` also folds in workspace-scoped (`product_id IS NULL`) legacy seeds (Phase 2 retires the last true caller on the owner surface — the scout keeps the fold until Phase 3 purges the seeds). Default order `created_at DESC`, default limit 500. |
| `getCompetitor(id, { workspaceId? })` | → `CompetitorRow \| null`. Optional `workspaceId` scope-guard. |
| `getCompetitorBrandsById(workspaceId, ids)` | → `Map<id, brand>`. Resolves `runs_ads_for` (self-FK) → the fronted competitor's brand for a set of ids — the GET route + `loadHubData` both use it to render "runs ads for {brand}" without a second lookup. |
| `upsertCompetitor(row)` | → `CompetitorRow`. Insert-or-update chokepoint on `(workspace_id, brand)`. General write surface for manual/script/backfill writes (`discoverCompetitors` / `promoteWhitelistedPages` still use the narrower private `upsertCandidate`). |
| `setCompetitorStatus(id, status, reviewedBy, note?, { workspaceId?, expectedStatus? })` | → `CompetitorRow \| null`. Flip status with optional workspace scope-guard + expected-status compare-and-set (idempotent review — a stale async read can't overwrite a settled row). Returns null when guards filter it out. |
| `deleteCompetitor(id, { workspaceId? })` | → `void`. Hard-delete one row. `runs_ads_for` self-FK is `ON DELETE SET NULL`. |
| `listOrphanCompetitors(workspaceId)` | → `CompetitorRow[]`. Rows with a null `product_id` OR a `product_id` that no longer exists in the workspace's `products` table (migrated-seed remnants — the 46 legacy null-scoped rows). Read-only. |
| `deleteOrphanCompetitors(workspaceId)` | → `{ deleted, ids }`. Purges what `listOrphanCompetitors` returns. Idempotent. Phase 3 of the chokepoint spec runs this. |

### Discovery + read helpers (pre-existing)

| Export | Notes |
|---|---|
| `loadApprovedCompetitorsForProduct(workspaceId, productId)` | → `Seed[]` — the **per-product scout read path** (CEO 2026-07-12). ONLY `status='approved'` rows for ONE `product_id`, as `{ keyword, kind:'competitor', note, competitorId, productId }` — the `competitorId`/`productId` flow through `ingestAd` onto every skeleton. `search_keyword` (verbatim) wins over `brand`. Empty ⇒ zero pulls for that product. |
| `productsWithApprovedCompetitors(workspaceId)` | → `string[]` — distinct `product_id`s with ≥1 approved competitor. The [[../inngest/creative-scout]] weekly cron's product work-list. |
| ~~`loadApprovedCompetitorSeeds(workspaceId)`~~ | RETIRED 2026-07-12 — the workspace-wide read (all approved, no product context) that fed the old workspace-wide sweep. Superseded by `loadApprovedCompetitorsForProduct`. |
| `discoverCompetitors(workspaceId, productId)` | LLM ([[ai-models]] `OPUS_MODEL`) + web search proposes the competitive set framed by product intelligence; inserts `source='llm'`, `status='proposed'` with brand/domain/pdp_urls/evidence. → `{ proposed, skippedExisting, candidates }`. |
| ~~`promoteFromCategorySweep(workspaceId)`~~ | RETIRED 2026-07-12 — category-sweep competitor auto-discovery. Contradicted the fully-deliberate model (competitors chosen by hand). No category skeletons exist to scan anymore. |
| `promoteWhitelistedPages(workspaceId, { minAds=3, minShare=0.5 })` | Scans [[../tables/creative_skeletons]] for advertiser pages whose ads point at a KNOWN approved-competitor `destination_domain`; proposes each recurring page (≥`minAds` ads, ≥`minShare` share fronting known competitors) as `source='whitelisted'` with `search_keyword`=the raw page name, `runs_ads_for`=the fronted competitor id, and `product_id` INHERITED from the fronted competitor's `product_id` (Phase 3 — so a whitelisted-page proposal is never orphaned). → `{ promoted, skippedExisting, scanned }`. See [[../specs/whitelisted-page-auto-tracking]]. |
| `normalizeBrand(raw)` | lowercase, strip protocol/www/TLD/path/non-alphanumeric → the compact handle + dedup key. |
| `CompetitorRow` / `CompetitorSource` / `CompetitorStatus` / `ListCompetitorsOptions` / `UpsertCompetitorInput` / `SetCompetitorStatusOptions` / `DiscoverResult` / `PromoteResult` | types |

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
- [[../inngest/creative-scout]] (`loadApprovedCompetitorsForProduct`, `productsWithApprovedCompetitors`, `promoteWhitelistedPages`).
- [[../inngest/acquisition-research-cadence]] (`promoteWhitelistedPages`).
- `src/app/api/ads/competitors` (`listCompetitors` + `getCompetitorBrandsById` on GET; the POST triggers discovery via Inngest) and `.../[id]` (`getCompetitor` + `setCompetitorStatus` on approve/reject) — the owner surface.
- [[acquisition-hub]] (`loadHubData`) — `listCompetitors` + `getCompetitorBrandsById` for the Acquisition Research Hub's Competitor set section.
- [[landing-page-scout]] (`loadLanderTargets`) — `listCompetitors({status:'approved', productId, includeUnscoped: !!productId})` for the capture pipeline's competitor lander sources.

## Related
[[../tables/competitors]] · [[adlibrary]] · [[creative-skeleton]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]] · [[../inngest/competitor-scout]] · [[../specs/competitor-scout]] · [[../specs/ad-creative-scout]] · [[../specs/landing-page-scout]]
