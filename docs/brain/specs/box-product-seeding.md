# Box-driven Product Seeding ⏳

**Owner:** [[../functions/cmo]] · **Parent:** CMO mandate — owned product/website content (grounds [[../lifecycles/product-intelligence]])

Populate a product's **entire** intelligence/content set from near-zero input by **re-hosting the existing [[../lifecycles/product-intelligence]] Engine on the build box** instead of Inngest. The Engine pipeline already exists and is correct — its problem is **runtime**: per-ingredient research over ~16 ingredients + map-reduce over ~2000 reviews + content gen exceed Inngest step limits and get killed by Vercel deploys. The box runs unbounded `claude -p` (Max-billed), so it just *runs the same logic to completion*. Reuse the Engine verbatim; only the **execution host** changes — plus three additions: PDP ingredient auto-extraction, auto benefit-selection from core-desires, and Nano Banana imagery.

**Outcome:** enter (almost) nothing → a fully published product (ingredients → research → review analysis → benefit selections → PDP content → hero/lifestyle/ingredient images), with no per-step babysitting.

## Why the box, not Inngest
The Engine (`src/lib/inngest/product-intelligence.ts`) is sound but unreliable at runtime: `researchIngredients` per-ingredient + `analyzeReviews` over thousands of reviews + `generateContent` are long; Inngest step timeouts + deploy-kills strand runs (e.g. 12 of 16 Superfood Tabs ingredients once stranded). The box already runs long jobs to completion — the right host.

## Mechanism (reuse the box queue)
- New `agent_jobs.kind='product-seed'` claimed via `claim_agent_job(['product-seed'])` into its own lane; `runProductSeedJob(job)` branch in `scripts/builder-worker.ts` (alongside `runJob`/`runPlanJob`/`runFoldJob`).
- Enqueued from `/dashboard/products/[id]/intelligence` ("Auto-populate" button) with `{ product_id, core_desires }`.
- **Reuse the Engine logic** — factor the four worker bodies out of their Inngest `step.run` wrappers into plain async functions the box calls directly (no nested Inngest, no nested `claude`). Same code path the UI uses; just driven sequentially on the box.

## Input (minimal — the whole point)
- **Ingredients: auto-extracted from the live PDP.** Tested 2026-06-19: the "Clinically Studied Ingredients" chapter is server-rendered HTML at `superfoodscompany.com/products/{handle}` (18 ingredients + descriptions for Ashwavana Guru Focus). The box fetches the page + extracts names/dosages → `product_ingredients`. (Theme access via [[../recipes/..|reconcile-shopify-theme]] is the fallback.) Manual entry still possible if no chapter exists.
- **Core desires:** the owner sets 2–3 per product (e.g. "focus · calm · no-crash") — the single strategic input; anchors benefit-selection + content.
- **Variant photo:** already present (`product_media`/`product_variants` exist for the targets); the hero packshot source for Nano Banana.

## Pipeline (the Engine, run to completion on the box)
1. **Extract ingredients** from the PDP → `product_ingredients` → `intelligence_status='ingredients_added'`.
2. **`researchIngredients`** (reuse) → `product_ingredient_research` (mechanism, clinical benefits, citations, dosage, contraindications) — fault-isolated per ingredient → `research_complete`.
3. **`analyzeReviews`** (reuse) over `product_reviews` (workspace DB), **4–5★ only, weighting `featured`/`smart_featured` first** (already the Engine's behavior), map-reduce chunks → `product_review_analysis` → `reviews_complete`.
4. **Auto benefit-selection** (replaces the manual UI step): pick lead + supporting benefits aligned to `core_desires`, using the existing `science_confirmed` (from ingredient research/clinical) + `customer_confirmed` (from review analysis) flags + evidence (`review IDs` + `ingredient_research IDs`) → `product_benefit_selections` → `benefits_selected`.
5. **`generateContent`** (reuse) → `product_page_content` (hero, mechanism, ingredient cards, comparison, FAQ, guarantee, expectation timeline, endorsements, KB article, support macros) + `product_how_it_works` → `content_generated`.
6. **Nano Banana imagery** (reuse `src/lib/gemini.ts` `getGeminiCredentials(workspaceId)` → `workspaces.gemini_api_key_encrypted`): **hero packshot** (from the variant photo) + **lifestyle** + **ingredient-callout** images → `product_media`, attached to the PDP blocks.
7. **Auto-publish** → `intelligence_status='published'` (owner's choice — no draft gate). Every stage stays re-runnable (`raw_ai_response` + `*_at` preserved).

## Supervision (North star)
Auto-publishing still answers to a supervisor: each run posts a **summary + the box's reasoning**, every output is **editable in the Engine UI** (the override surface), and the whole run is **re-runnable/replayable**. The box optimizes the bounded proxy (a complete product); the owner owns the objective via the Engine UI.

## Products to complete (canonical targets, by Shopify handle)
The box resolves each via `products.handle` → fetches `superfoodscompany.com/products/{handle}` for the ingredient chapter:
- `ashwavana-guru-focus` · `ashwavana-zen-relax` · `amazing-coffee-pods` · `amazing-creamer` · `creatine-prime`

(`ashwavana-guru-focus`/`zen-relax`/`creatine-prime` probed at `intelligence_status='none'`; variant photos + media already exist. **Amazing Coffee** — the non-pods original — is the done reference, `published`.)

## Tested feasibility (2026-06-19)
- ✅ PDP ingredient chapter readable via plain fetch (server-rendered HTML).
- ✅ Image gen exists — `gemini.ts` (Seedream/Soul) via the per-workspace `gemini_api_key_encrypted`; the key is present in the workspace.
- ✅ `product_reviews` has `rating` + `featured`; Engine already pulls 4★+ featured-first.
- ✅ Engine pipeline + the 7 tables + `intelligence_status` enum all exist — only the host changes.

## Safety / invariants
- **Reuse the Engine logic verbatim** — do not fork the research/review/content logic; factor it to shared functions both the UI (Inngest) and the box call.
- **Box rules:** native tools only, no nested `claude`; Max-billed (no `ANTHROPIC_API_KEY` in env).
- **Reviews:** workspace `product_reviews` only, 4–5★, featured-weighted.
- **Images:** workspace Gemini key (decrypt via `crypto.ts`); never commit keys.
- Re-runnable/replayable; every output editable in the Engine UI.

## Completion criteria
- One "Auto-populate" action on a product → a `product-seed` box job that drives it `none → published`: PDP-extracted ingredients, research, review analysis, core-desire-aligned benefit selections (science+customer confirmed), page content, and Nano Banana hero/lifestyle/ingredient media — unattended. The four target products complete this way; the path matches Amazing Coffee's done state.

## Related
[[../lifecycles/product-intelligence]] · [[../inngest/product-intelligence]] · [[../libraries/gemini]] · [[../tables/products]] · [[../tables/product_ingredients]] · [[../tables/product_reviews]] · [[../tables/product_media]] · [[../tables/agent_jobs]] · [[roadmap-build-console]] · [[../recipes/build-box-setup]]
