# inngest/auto-blog

The daily engine that auto-generates a human-voiced, intelligence-grounded blog post per eligible workspace and auto-publishes it to the storefront blog. End-to-end flow: [[../lifecycles/auto-blog-generation]].

**File:** `src/lib/inngest/auto-blog.ts` · registered in `src/app/api/inngest/route.ts`.

## Functions

### `auto-blog`
- **Trigger:** cron `0 13 * * *` **+** the `auto-blog/tick` event (manual / on-demand kick).
- **Per eligible workspace** (a published-intelligence product with an isolated, our-storage variant image — today Superfoods), wrapped in its own **try/catch** so one workspace's failure never blocks the others:
  1. `selectTopic` ([[../libraries/blog__select-topic]]) — pick product (round-robin by fewest AI posts), least-covered archetype, an uncovered SEO keyword, the persona, the isolated variant image, and the bundled proprietary intelligence.
  2. `writePost` ([[../libraries/blog__write-post]]) — Opus 4.8 + the Anthropic web-search server tool → title/handle/seo/tags/HTML + image prompts.
  3. `generateImages` / `genSocialVariant` ([[../libraries/blog__generate-images]]) — NBP hero composite + 1–2 in-body, sharp→WebP, 4:5 social variant; upload → swap URLs into the HTML.
  4. **Insert** [[../tables/posts]] (`source='ai_generated'`, `author_slug`, `published=true`) + replace [[../tables/post_products]]. **Handle de-dup** so it never clobbers an existing post.

## Downstream events sent

_None._ (Generated posts render through the existing storefront blog + portal Resources surfaces — [[../lifecycles/blog-resources]] — no further events.)

## Tables written

- [[../tables/posts]]
- [[../tables/post_products]]

## Tables read (not written)

- [[../tables/product_seo_keywords]] · [[../tables/product_ingredient_research]] · `product_ingredients` · `product_review_analysis` · `product_benefit_selections` · [[../tables/product_variants]] (isolated image) — via [[../libraries/blog__select-topic]].

---

[[../README]] · [[../integrations/inngest]] · [[../lifecycles/auto-blog-generation]] · [[../../CLAUDE]]
