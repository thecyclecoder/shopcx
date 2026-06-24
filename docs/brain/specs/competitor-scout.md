# Competitor Scout — DB-driven per-product competitor set

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] (M1 — the foundation)

The foundation of the [[../goals/acquisition-research-engine|Acquisition Research Engine]]: a per-product agent that identifies + ranks the real competitors and writes them to a **DB-driven `competitors` table**, replacing the **hardcoded `COMPETITOR_SEEDS`** in `src/lib/adlibrary.ts` (which violates the "never hardcoded, always DB-driven" rule). Both downstream scouts ([[ad-creative-scout]], [[landing-page-scout]]) read this set — neither re-derives competitors.

## What it does
- **Identifies competitors per product** from multiple signals: (a) **LLM + web search** — the direct competitive set + each brand's **domain + canonical PDP/lander URLs**; (b) **category-sweep promotion** — heavy advertisers that recur in [[../integrations/adlibrary|AdLibrary]] category sweeps (the code already anticipates this: *"new heavy advertisers surfaced there can be promoted into the competitor list over time"*); (c) **product intelligence** — the product's category/claims/positioning frame the competitive set.
- **Supervisable (north-star):** proposes competitor additions *with evidence* (why they compete, ad-spend signal) → owner approves/rejects. The set is curated, never silently drifting.

## Schema — `competitors` table
`id · workspace_id · product_id (the product they compete with) · brand · domain · pdp_urls (text[]) · category · spend_signal · source ('llm'|'category_sweep'|'manual') · status ('proposed'|'approved'|'rejected') · evidence · created_at`. Migration `supabase/migrations/…_competitors.sql` + a Sonnet data tool (customer-referenced? no — but add to the optimizer/scout read path). Seed it by **migrating the 11 hardcoded `COMPETITOR_SEEDS`** in as `status='approved'`.

## Phase 1 — competitors table + the discovery agent + migrate the hardcoded seeds
Migration + the discovery pass (LLM/web-search + category-sweep promotion + product-intelligence) authoring `proposed` competitors with evidence; the owner approve/reject surface; migrate `COMPETITOR_SEEDS` → DB rows and point `adlibrary.ts`'s sweep at the table (not the hardcoded list). Brain: [[../goals/acquisition-research-engine]] · [[../integrations/adlibrary]] · [[../libraries/adlibrary]] · [[ad-creative-scout]] · [[landing-page-scout]] · [[../specs/repair-agent]] (propose→approve pattern).

**Built (code-complete, tsc-clean; migration applied to prod ✅):**
- `supabase/migrations/20260623120000_competitors.sql` — the `competitors` table (workspace-member SELECT / service-role write RLS, `UNIQUE(workspace_id, brand)`, source/status CHECKs) + in-migration seed of the 11 `COMPETITOR_SEEDS` as `status='approved'` for every ad-tool workspace. Applied via `scripts/apply-competitors-migration.ts`. Table page: [[../tables/competitors]].
- `src/lib/competitors.ts` ([[../libraries/competitors]]) — `loadApprovedCompetitorSeeds` (sweep read path), `discoverCompetitors` (LLM + web search, product-intelligence-framed, proposes `source='llm'`), `promoteFromCategorySweep` (recurring AdLibrary advertisers → `source='category_sweep'` proposals), `normalizeBrand` dedup.
- `src/lib/inngest/competitor-scout.ts` ([[../inngest/competitor-scout]]) — `competitor-scout-discover` on event `ads/competitor-scout.discover { workspaceId, productId }`; registered in `registered-functions.ts`.
- `src/lib/adlibrary.ts` — removed hardcoded `COMPETITOR_SEEDS`/`ALL_SEEDS` (kept `CATEGORY_SEEDS`); `src/lib/inngest/creative-finder.ts` now builds per-workspace seeds = approved competitors + categories and runs the category-sweep promotion step.
- `src/app/api/ads/competitors/route.ts` (GET list / POST discover) + `[id]/route.ts` (POST approve|reject) — the owner surface (owner/admin gated, audit-stamped).

## Verification
- After applying `scripts/apply-competitors-migration.ts`: `select status, count(*) from competitors group by status` → 11 `approved` rows per ad-tool workspace (the migrated seeds: `everydaydose`…`bloomnu`), all `source='manual'`.
- `POST /api/ads/competitors { workspaceId, productId }` (as owner/admin) for a product → fires `ads/competitor-scout.discover`; within ~1–2 min `GET /api/ads/competitors?workspaceId=&status=proposed&productId=` returns a ranked set with `brand` + `domain` + `pdp_urls` + `evidence`, all `source='llm'`, `status='proposed'`.
- `POST /api/ads/competitors/{id} { workspaceId, action:"approve" }` → that row flips to `status='approved'`, `reviewed_by`/`reviewed_at` stamped; re-POSTing returns `409 Already approved`.
- Fire `ads/creative-finder.sweep { workspaceId }` → in the function logs, the per-workspace seed list = the approved `competitors` brands + `CATEGORY_SEEDS` (no `everydaydose`-style hardcoded constant; `COMPETITOR_SEEDS`/`ALL_SEEDS` no longer exist in `src/lib/adlibrary.ts`).
- After a sweep produces `creative_skeletons` rows, the `promote-{workspaceId}` step → a recurring advertiser (≥3 ads) not already a competitor appears as a `source='category_sweep'`, `status='proposed'` row; re-running the sweep does NOT duplicate it.
- Negative: `POST /api/ads/competitors/{id} { action:"reject" }` then re-running discovery/promotion → the rejected brand does NOT re-appear (deduped on `(workspace_id, brand)` across all statuses). A workspace with zero `approved` rows → the sweep runs only `CATEGORY_SEEDS`, never a hardcoded competitor.
