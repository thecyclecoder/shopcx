# `src/lib/blog/select-topic.ts` — pick what the next auto-blog post is about

Step 1 of the auto-blog pipeline ([[../lifecycles/auto-blog-generation]]). Chooses the product, archetype, keyword, and persona for the next scheduled post, and bundles the proprietary intelligence the writer grounds in. Pure selection — no LLM, no writes.

## Exports

| Export | Shape | Notes |
|---|---|---|
| `selectTopic(workspaceId)` | `→ { product, archetype, keyword, persona, isolatedImageUrl, intelligence } \| null` | `null` when no eligible product. |

## How it selects
- **Product** — a product with `intelligence_status='published'` ([[../lifecycles/product-intelligence]]), **round-robin by fewest existing AI posts** (least-recently-posted), weighted toward products with unused SEO keywords.
- **Archetype** — the **least-covered** of `recipes` · `science` · `how_it_works` · `how_to_use` (counted against existing `posts`).
- **Keyword** — an **uncovered** target from [[../tables/product_seo_keywords]] (deduped against existing post titles + `content_text`).
- **Persona** — the [[blog__authors]] persona matching the archetype (recipe → Renee, science/explainer → Priya RD, lifestyle → Marcus).
- **Isolated image** — `product_variants.image_url` (our storage — the styled pouch on a light bg; NOT the Shopify-CDN `products.variants` JSON), the NBP hero input.
- **Intelligence bundle** — ingredients, [[../tables/product_ingredient_research]] (+ real citations), review phrases, benefits — the first-hand/proprietary data the writer leans on for E-E-A-T.

## Gotchas
- **Isolated image is mandatory for eligibility** — no our-storage variant image ⇒ the product is skipped (the hero can't be composited).
- **Dedup is on title + content_text**, not keyword alone, so paraphrased repeats are still caught.

## Callers
- [[../inngest/auto-blog]] — step 1 of the daily run.

## Related
[[../lifecycles/auto-blog-generation]] · [[blog__write-post]] · [[blog__authors]] · [[../tables/product_seo_keywords]] · [[../tables/product_ingredient_research]] · [[../lifecycles/product-intelligence]]
