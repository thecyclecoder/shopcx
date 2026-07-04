# inngest/product-intelligence

The four Sonnet workers that drive the Product Intelligence Engine pipeline. End-to-end flow in [[../lifecycles/product-intelligence]].

**File:** `src/lib/inngest/product-intelligence.ts`

> **Shared core (no fork) — [[../specs/box-product-seeding]].** The research/review/content logic now lives in [[../libraries/product-intelligence-seed|`src/lib/product-intelligence/engine.ts`]]; these Inngest functions call the shared functions (`researchOneIngredient`, `analyzeReviewChunk`/`reduceReviewAnalysis`/`persistReviewAnalysis`, `generateContentCore`) **inside** their `step.run` wrappers. The build box (`agent_jobs.kind='product-seed'` → `runProductSeedJob`) runs the SAME functions in-process to completion — same code path, different host.

## Functions

### `intelligence-research-ingredients`
- **Trigger:** event `intelligence/research-ingredients`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspace_id" }]`


### `intelligence-analyze-reviews`
- **Trigger:** event `intelligence/analyze-reviews`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]`


### `intelligence-generate-content`
- **Trigger:** event `intelligence/generate-content`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 2, key: "event.data.workspace_id" }]`


### `intelligence-research-benefit-gap`
- **Trigger:** event `intelligence/research-benefit-gap`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]`
- **Anthropic fetch bound at 600s** via `AbortSignal.timeout(600_000)` — the direct `fetch('https://api.anthropic.com/v1/messages', …)` (same pattern as `callSonnet` in [[../libraries/product-intelligence-seed|engine.ts]]) throws `"Anthropic call timed out after 600s"` on abort, so the step retries under Inngest's `retries: 2` instead of the whole Lambda being reaped by Vercel at 800s (Control Tower signature `vercel:bb28f61b887be822`).


## Downstream events sent

_None._

## Tables written

- [[../tables/product_ingredient_research]]
- [[../tables/product_page_content]]
- [[../tables/product_review_analysis]]
- [[../tables/products]]

## Tables read (not written)

- [[../tables/product_benefit_selections]]
- [[../tables/product_ingredients]]
- [[../tables/product_media]]
- [[../tables/product_reviews]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
