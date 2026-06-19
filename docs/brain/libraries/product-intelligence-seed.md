# `src/lib/product-intelligence/*` — the Engine core + box seeding pipeline

The Product Intelligence Engine, factored out of its Inngest wrappers so **both hosts run identical logic** ([[../specs/box-product-seeding]]): the UI path ([[../inngest/product-intelligence]]) wraps each call in a `step.run`; the box path (`runProductSeedJob` in `scripts/builder-worker.ts`) calls them directly, in-process, to completion. **Reuse, never fork** — one copy of every prompt/parser/reduce/row-shaper.

## `engine.ts` — shared Engine core

| Export | Notes |
|---|---|
| `callSonnet(system, user, maxTokens, temp)` | Anthropic Messages API (`process.env.ANTHROPIC_API_KEY`, model [[../libraries/ai-models\|SONNET]]). Worker process keeps the key; only the spawned build sandbox strips it |
| `callSonnetVision(system, user, images[], maxTokens, temp)` | vision variant — base64 image blocks; used by the self-QA hero check |
| `extractJson<T>(text)` | tolerant JSON extraction (fences / substring salvage) |
| `researchOneIngredient(admin, {…})` · `researchIngredientsCore(admin, {…})` | per-ingredient research → `product_ingredient_research`, fault-isolated |
| `fetchReviewsForAnalysis` · `analyzeReviewChunk` · `reduceReviewAnalysis` · `persistReviewAnalysis` · `analyzeReviewsCore` | 4–5★, featured-weighted, 100-review map-reduce → `product_review_analysis` |
| `generateContentCore(admin, {…})` | fetch context → Sonnet → insert a new draft `product_page_content` version |

## `extract-ingredients.ts` — step 1 (PDP auto-extraction)

`seedIngredientsFromPdp(admin, {workspace_id, product_id, handle})` → fetches `superfoodscompany.com/products/{handle}`, strips HTML to text, Sonnet pulls the clinically-studied ingredient list → `product_ingredients`. **Idempotent:** keeps existing ingredients (manual entry wins).

## `benefit-selection.ts` — step 4 (triangulation)

`selectBenefits(admin, {workspace_id, product_id, handle?, angle_override?})` → triangulates **(a)** the PDP angle (anchor, not ceiling) + **(b)** clinical evidence + **(c)** review language → `product_benefit_selections` with lead/supporting/skip roles + evidence IDs (`ingredient_research_ids`, `customer_review_ids`). Same theme shape as the UI's `reconcile-benefits` route.

## `hero-imagery.ts` — step 6 (Nano Banana Pro)

`generateHero(admin, {…})` → resolves the front-facing packshot ([[google-drive]]) + the `Hero Example` refs, calls [[gemini]] `generateNanoBananaProCombine` with the **locked composition** prompt, **vision-confirms** (correct variant / contained splash / right drink / no edge cutoffs) with one retry, then upserts a `product_media` slot=`hero` row. **🔒 Locked-aware:** `LOCKED_HERO_HANDLES` (amazing-coffee, amazing-coffee-pods, amazing-creamer) skip image gen; idempotent skip if a hero already exists.

## `publish.ts` — step 8 (shared publish)

`publishProductContent(admin, {workspace_id, product_id, contentId})` → support macros (inactive) + KB article upsert + `status='published'` + `intelligence_status='published'`. Called by **both** the box and the `page-content/[id]/publish` route.

## `seed.ts` — the orchestrator

`runProductSeed({workspace_id, product_id, angle_override?})` drives steps 1–8 sequentially with status updates, a **self-QA gate** (benefit claims trace to evidence · FDA/DSHEA disclaimer present · hero vision-confirmed · "what it doesn't do" present), and **auto-publish only on QA pass**. Held runs stay `content_generated` and surface the issue. Returns `{steps, reasoning, hero, qa, …}` — the supervision summary the worker posts back on the job.

## Related
[[../lifecycles/product-intelligence]] · [[../inngest/product-intelligence]] · [[google-drive]] · [[gemini]] · [[../tables/agent_jobs]] · [[../tables/product_ingredients]] · [[../tables/product_media]] · [[../specs/box-product-seeding]]
