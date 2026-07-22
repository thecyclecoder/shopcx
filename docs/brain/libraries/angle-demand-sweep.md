# `src/lib/ads/angle-demand-sweep.ts`

The **search-demand feeder** behind [[../tables/product_angle_palette]]`.search_demand` — turns an (ingredient, problem-lane) pair into a demand tier grounded in real search-volume evidence, and drives the daily sweep executor that either REFRESHES existing palette rows or SURFACES is_active=false drafts for previously-uncovered high-tier lanes.

Without this feeder, `search_demand` is set by the seed author's judgement and every downstream selector (compose-engine, seed-remaining-5-products, Dahlia auto-fan-out when the palette starves) inherits that lie. Implements the demand-sourced-angle-sweep spec (M2 of [[../goals/v3-ad-creative-engine]]).

## Design principles

- **Callers stay blind to the provider.** `fetchSearchDemand` is a single chokepoint; whether the score came from [[../tables/product_seo_keywords]], a future paid source (Ahrefs/SEMrush), or the built-in stub is a swap of `activeProvider`, not a rewrite of every caller.
- **Owner-gated per the north-star rail.** The sweep NEVER flips a palette row is_active on its own. A new high-tier lane surfaces as an is_active=false, `source='dahlia_fanned'` draft; the owner promotes it via the angles page. Every run writes one `director_activity` audit row so the reasoning is inspectable.
- **Idempotent.** Every re-run re-refreshes existing rows to the current tier + re-checks each no-match lane; the palette's `(workspace, product, theme, problem)` unique key prevents draft duplication.

## Types

- `SearchDemandRecord` = `{ tier: 'high' | 'medium' | 'low'; rawVolume: number | null; source: string }`.
- `FetchSearchDemandInput` = `{ admin; workspaceId; ingredient; problem }` — **fixed shape** so a caller cannot smuggle an alternate table, select list, or filter clause (defense-in-depth; the arg surface is an untrusted capability boundary).
- `SearchDemandProvider` = `(input) => Promise<SearchDemandRecord>` — the escape hatch a future spec grafts a real data source onto without touching callers.
- `SweepSummary` = `{ rowsRefreshed; draftsCreated; provider }` — returned by `runSweepForProduct`.

## Exports

- **`HIGH_MIN_VOLUME = 1000`, `MEDIUM_MIN_VOLUME = 100`** — the named tier boundaries. Aligned with the primary/secondary/long_tail relevance bands `src/lib/inngest/seo-keyword-research.ts` already assigns when it writes `product_seo_keywords` rows. Tunable by a later spec without a code rewrite.
- **`fetchSearchDemand(input: FetchSearchDemandInput)` → `Promise<SearchDemandRecord>`** — the chokepoint. Read order: (1) [[../tables/product_seo_keywords]] rows scoped to the workspace whose `keyword` mentions BOTH the ingredient AND at least one problem-lane token (via `problemTokens` — lowercased, ≥3-char, stopwords dropped) — derive the tier from `max(monthly_searches + search_console_impressions)`; (2) `activeProvider` (default: `stubProvider` → `{tier:'medium', rawVolume:null, source:'stub'}`).
- **`stubProvider`** — the built-in provider that returns the neutral medium tier so a demand-blind lane doesn't score high by accident.
- **`setSearchDemandProvider(p)` / `resetSearchDemandProvider()`** — swap the active provider (test seams + a future paid-source spec).
- **`tierForVolume(volume)`** — pure derivation used by `fetchSearchDemand`.
- **`problemTokens(problem)`** — the tokenizer used to match a `product_seo_keywords` row against the caller's problem lane.
- **`PROBLEM_LANES`** — the fixed enumeration of `(theme, problem)` pairs swept per ingredient (17 lanes across the 6 [[../libraries/angle-palette]] `AngleTheme` slots). Kept as a constant table (not a computed cross-product) so the audit trail is explicit — a later spec adds / drops / renames a lane by editing this table alone.
- **`runSweepForProduct({admin, workspaceId, productId, ingredientNames?})` → `Promise<SweepSummary>`** — the sweep executor. Sources ingredients via [[product-intelligence]] `getProductIntelligence` (opt-out via `ingredientNames` for tests only), iterates ingredient × PROBLEM_LANES, and for each lane either (a) REFRESHES `search_demand + notes` on the matching existing palette row via [[angle-palette]] `refreshAngleSearchDemand` — targeted, never touches is_active/enemy/mechanism/proof; or (b) UPSERTS a `source='dahlia_fanned'`, `evidence_tier='customer_only'`, `is_active=false` draft via [[angle-palette]] `upsertAngle` for a previously-uncovered high-tier lane. Writes ONE [[../tables/director_activity]] row per run (`director_function='growth'`, `action_kind='angle_demand_sweep_ran'`) summarizing counts + providers.

## Callers / purpose

- **[[../inngest/angle-demand-sweep-cadence]]** — daily cron `30 10 * * *` that enumerates ad-tool workspaces × active products and calls `runSweepForProduct` per product; the manual event fan-out (`ads/angle-demand-sweep.cadence`) is a per-workspace or per-product on-demand path. Ends the outer step with `emitCronHeartbeat` per the CLAUDE.md § Node completeness rail.

## Gotchas

- **Never writes raw to `product_angle_palette`.** Every write flows through the [[angle-palette]] SDK — `upsertAngle` for new drafts (with the new `isActive:false` field), `refreshAngleSearchDemand` for targeted refresh. A raw `.from('product_angle_palette').update/insert/delete` inside the sweep is a bug — the SDK is the chokepoint.
- **Never flips is_active on its own.** The refresh patch is scoped to `search_demand + notes + updated_at`; a new draft is always written `is_active=false`. That gate is what makes this a supervisable-autonomy node (owner promotes, sweep proposes).
- **The arg surface is a fixed shape.** `fetchSearchDemand` cannot be tricked into selecting sensitive columns or querying a different table — the SELECT list is a fixed allowlist, the ingredient text goes only into the ILIKE bound value, and the workspace scope is always applied.
- **Empty ingredient short-circuits to the provider.** No DB read happens; the provider (default: stub) fires directly. Prevents an unbounded `ilike '%%'` scan.

---

[[../README]] · [[angle-palette]] · [[../inngest/angle-demand-sweep-cadence]] · [[../tables/product_seo_keywords]] · [[../tables/product_angle_palette]] · [[product-intelligence]] · [[director-activity]] · [[control-tower]] · [[../../CLAUDE]]
