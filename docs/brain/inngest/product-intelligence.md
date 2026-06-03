# inngest/product-intelligence

The four Sonnet workers that drive the Product Intelligence Engine pipeline. End-to-end flow in [[../lifecycles/product-intelligence]].

**File:** `src/lib/inngest/product-intelligence.ts`

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
