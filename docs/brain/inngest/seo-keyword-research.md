# inngest/seo-keyword-research

Generates `product_seo_keywords` via Google Search Console + AI keyword extraction.

**File:** `src/lib/inngest/seo-keyword-research.ts`

## Functions

### `seo-keyword-research`
- **Trigger:** event `seo/research-keywords`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 2, key: "event.data.workspace_id" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/product_seo_keywords]]

## Tables read (not written)

- [[../tables/product_benefit_selections]]
- [[../tables/product_ingredients]]
- [[../tables/product_page_content]]
- [[../tables/product_review_analysis]]
- [[../tables/products]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
