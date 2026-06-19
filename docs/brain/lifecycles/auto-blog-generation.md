# Lifecycle: auto-generated blog posts (scheduled)

A daily engine that turns [[product-intelligence|product intelligence]] (ingredients, benefits, SEO keywords, real PubMed-style citations) + live web research into a genuinely useful, human-voiced blog post with original branded imagery, and auto-publishes it to the storefront blog. Each post serves one of three goals: **rank** on a target keyword, **provide value** to buyers (recipes / how-to), or **reinforce value** for considerers (science / myth-busting). Renders through the existing public blog + portal Resources surfaces ([[blog-resources]]) — no new render work; this lifecycle is the *generation* half, [[blog-resources]] is the *import + render* half.

**Code:** `src/lib/inngest/auto-blog.ts` (daily cron, [[../inngest/auto-blog]]) · `src/lib/blog/select-topic.ts` ([[../libraries/blog__select-topic]]) · `src/lib/blog/write-post.ts` ([[../libraries/blog__write-post]]) · `src/lib/blog/generate-images.ts` ([[../libraries/blog__generate-images]]) · `src/lib/blog/authors.ts` ([[../libraries/blog__authors]]) · `src/app/(storefront)/store/[workspace]/links/page.tsx` (link-in-bio). **Table:** [[../tables/posts]] (+ [[../tables/post_products]]).

## Pipeline (per scheduled run)

```
cron 0 13 * * *  (+ auto-blog/tick event)
  ▼  per eligible workspace (try/catch isolated — one failure never blocks others)
1. SELECT  — select-topic.ts: a published-intelligence product (round-robin, fewest AI posts),
             the least-covered archetype (recipes / science / how_it_works / how_to_use), an
             uncovered SEO keyword, the matching persona, the isolated variant image, and the
             bundled proprietary intelligence (ingredients, research + citations, review phrases).
2. WRITE   — write-post.ts: Opus 4.8 + the Anthropic web_search server tool researches live,
             grounds in the intelligence, writes in-persona under the anti-AI voice rules, emits a
             delimited block (title/handle/seo/tags/HTML + hero & social prompts + {{IMAGE:…}}).
3. IMAGES  — generate-images.ts: Nano Banana Pro hero = composite(isolated pouch + scene prompt),
             1–2 in-body generated, all → sharp WebP; 4:5 social variant. Upload → swap into HTML.
4. PUBLISH — insert posts (source='ai_generated', author_slug, published=true) + post_products.
             Handle de-dup so it never clobbers an existing post.
```

## Why it's feasible (everything already exists)
- **Intelligence** — 7 tables per product ([[../tables/product_ingredient_research]] with real citations, [[../tables/product_seo_keywords]], review analysis, benefit selections). Amazing Coffee alone: 13 ingredients, 62 research rows, 50 keywords, 1,873 reviews.
- **Image gen** — [[../libraries/gemini]] `generateNanoBananaProCombine` (`gemini-3-pro-image`): pass the **isolated product pouch** (`product_variants.image_url`, our storage — NOT the Shopify-CDN `products.variants` JSON) + a scene prompt → photoreal hero with the real label intact.
- **Render** — the public blog + portal Resources already render `posts` with SEO + JSON-LD ([[blog-resources]]). The generator just writes rows.

## Making posts NOT read as AI (E-E-A-T)
Google penalizes **unhelpful, unoriginal, scaled content with no first-hand experience** — not "AI content" per se. Countermeasures baked into the writer:
1. **First-hand experience + proprietary data (#1 lever)** — every post leans on what only we have: real customer review phrases, our ingredient research + citations, recipe testing.
2. **Original branded imagery** — the NBP hero composites our real product photo (not stock, not obviously generated); styles vary across posts via `pickComposition`.
3. **Named human authors** — 3 invented personas with bios + avatars + JSON-LD `Person` byline (never "admin" / the org). See [[../libraries/blog__authors]].
4. **Anti-AI voice rules** — ban the tells ("in today's fast-paced world", "delve", "unlock", "game-changer", em-dash overuse, perfect triads); enforce burstiness, concrete numbers, real opinions.
5. **Structural + length variety** — rotate archetypes + templates so 365 posts don't share one skeleton; vary 700–1500 words.
6. **Real citations only** — cite actual studies we have; never fabricate DOI/PubMed links. Keep the FDA disclaimer ("studies describe ingredients, not the finished product").
7. **Editorial cadence + freshness** — staggered, `dateModified`, periodic re-touch.

## Locked decisions (2026-06-10)
- **Auto-publish** — posts go live immediately (`published=true`), no review gate. Revisit a spot-check queue only if a bad one slips.
- **Personas** — 3 invented authors in a **code registry** ([[../libraries/blog__authors]]), not a table: Renee Calhoun (Recipe Developer), Priya Anand RD (Nutrition Lead), Marcus Hale (Wellness Editor). `posts.author_slug` stamps the byline; rendered as photo + name + role + date + bio card + JSON-LD Person.
- **Two crops per post** — hero 16:9 (`featured_image_url`, the blog main) + the same scene re-rendered 4:5 portrait 1080×1350 (`social_image_url`, what the social poster posts, never shown on the blog). 4:5 is the tallest ratio IG/FB feed allows; aspect forced via NBP `imageConfig.aspectRatio`. The organic social scheduler prefers `social_image_url`, falls back to `featured_image_url`. *(History: 4:5 → 4:3 on 2026-06-12 → back to 4:5 on 2026-06-16 — Dylan wants portrait feed posts.)*
- **Image weight (quick-win)** — every NBP output runs through **sharp → WebP @ ≤1600px** (measured: 631KB JPEG → 66KB WebP, ~14× page-weight cut). Blog render lazy-loads in-body images, `fetchPriority="high"` on the LCP hero. Full AVIF/WebP multi-width pipeline (reuse [[../libraries/image-transcode]]) remains.
- **Link-in-bio** — a self-hosted **`/links` page** (`store/[workspace]/links/page.tsx`), mobile-first, latest posts + referenced products. The IG/FB Graph API **cannot set a profile's bio link** (read-only field), so the bio is pointed at `{domain}/links` **once** and the page always reflects current content (the standard self-hosted-Linktree creator pattern).

## Eligibility
Any workspace with a published-intelligence product (`intelligence_status='published'`) that has an isolated (our-storage) variant image — today that's Superfoods (Amazing Coffee, Amazing Creamer). A per-workspace enable flag + a dashboard "Generate now" button are the follow-ups.

## Status / open work

**Shipped:** Verified + archived 2026-06-18 ([[../archive]]). Daily Inngest cron ([[../inngest/auto-blog]], `0 13 * * *`) selects → writes (Opus 4.8 + web-search) → generates images (NBP + WebP + 4:5 social) → inserts `posts` (`source='ai_generated'`, `author_slug`) + `post_products`, auto-published. Per-workspace try/catch; handle de-dup. Author personas (registry + avatars + JSON-LD Person byline), WebP quick-win, 4:5 social variant + scheduler pickup, and the `/links` link-in-bio page all live. Two real prototype posts render live (`why-people-add-mushrooms-to-their-coffee`, `iced-brown-sugar-superfood-latte`).

**Known gaps / not yet shipped:**
- Dashboard "Generate now" button + per-workspace enable/cadence config.
- Full AVIF/WebP multi-width image pipeline (reuse [[../libraries/image-transcode]] `transcodeUpload` + `<picture>`/srcset) — applies to imported posts too.
- `Recipe` JSON-LD on recipe posts (rich results) in addition to `BlogPosting`.
- Optional `generation_meta` jsonb (model, keyword, archetype, research URLs, prompt version) for replay/audit.

**Open questions:** None blocking. Topic-priority weighting (lead with keyword coverage vs rotate the 3 goals) + volume (hard 1/day vs sprint-then-taper) tune over time.

## Related
[[blog-resources]] · [[product-intelligence]] · [[../inngest/auto-blog]] · [[../libraries/blog__write-post]] · [[../libraries/blog__select-topic]] · [[../libraries/blog__generate-images]] · [[../libraries/blog__authors]] · [[../libraries/gemini]] · [[../tables/posts]] · [[../tables/product_seo_keywords]] · [[../tables/product_ingredient_research]] · [[../customer-voice]]
