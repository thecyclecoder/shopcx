# Competitor Scout — DB-driven per-product competitor set ⏳

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] (M1 — the foundation)

The foundation of the [[../goals/acquisition-research-engine|Acquisition Research Engine]]: a per-product agent that identifies + ranks the real competitors and writes them to a **DB-driven `competitors` table**, replacing the **hardcoded `COMPETITOR_SEEDS`** in `src/lib/adlibrary.ts` (which violates the "never hardcoded, always DB-driven" rule). Both downstream scouts ([[ad-creative-scout]], [[landing-page-scout]]) read this set — neither re-derives competitors.

## What it does
- **Identifies competitors per product** from multiple signals: (a) **LLM + web search** — the direct competitive set + each brand's **domain + canonical PDP/lander URLs**; (b) **category-sweep promotion** — heavy advertisers that recur in [[../integrations/adlibrary|AdLibrary]] category sweeps (the code already anticipates this: *"new heavy advertisers surfaced there can be promoted into the competitor list over time"*); (c) **product intelligence** — the product's category/claims/positioning frame the competitive set.
- **Supervisable (north-star):** proposes competitor additions *with evidence* (why they compete, ad-spend signal) → owner approves/rejects. The set is curated, never silently drifting.

## Schema — `competitors` table
`id · workspace_id · product_id (the product they compete with) · brand · domain · pdp_urls (text[]) · category · spend_signal · source ('llm'|'category_sweep'|'manual') · status ('proposed'|'approved'|'rejected') · evidence · created_at`. Migration `supabase/migrations/…_competitors.sql` + a Sonnet data tool (customer-referenced? no — but add to the optimizer/scout read path). Seed it by **migrating the 11 hardcoded `COMPETITOR_SEEDS`** in as `status='approved'`.

## Phase 1 — competitors table + the discovery agent + migrate the hardcoded seeds ⏳
Migration + the discovery pass (LLM/web-search + category-sweep promotion + product-intelligence) authoring `proposed` competitors with evidence; the owner approve/reject surface; migrate `COMPETITOR_SEEDS` → DB rows and point `adlibrary.ts`'s sweep at the table (not the hardcoded list). Brain: [[../goals/acquisition-research-engine]] · [[../integrations/adlibrary]] · [[../libraries/adlibrary]] · [[ad-creative-scout]] · [[landing-page-scout]] · [[../specs/repair-agent]] (propose→approve pattern).

## Verification
- A product with no competitor rows → the agent proposes a ranked set (brand + domain + PDP URLs + evidence) in `status='proposed'`; the owner approves → `status='approved'`.
- The creative finder's sweep reads **approved `competitors` rows** for the workspace, not the hardcoded `COMPETITOR_SEEDS` (which is removed/migrated).
- A heavy advertiser recurring in category sweeps → surfaces as a `source='category_sweep'` proposal (deduped against existing rows).
- Negative: a rejected competitor doesn't re-surface; the agent never adds a competitor to the live sweep without owner approval.
