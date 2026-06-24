# PDP Refinement Pass — Fan-out to Remaining Products

**Owner:** [[../functions/cmo]] · **Parent:** CMO mandate — owned product/website content (extends [[box-product-seeding]]; runs on the same box/Max substrate). Derived from the Superfood Tabs refinement session (2026-06-20) — codified so it runs on **every** product without re-specifying.

The refinement pass — now the `refinement` mode of [[box-product-seeding]] — brings an already-published PDP to the "looks fantastic" bar hand-tuned on Tabs. Each run auto-harvests from **that product's own** live Shopify PDP / Drive / reviews: individual trust pills, a centered timeline, full-corpus 4★+ review analysis, per-variant Supplement Facts (HTML + KB mirror + `get_product_nutrition` orchestrator tool), real re-hosted nutritionist endorsements, up to 2 before/after stories (re-hosted photos), a 4-slide hero gallery (bag · Drive lifestyle · Nano-Banana static-ad · facts), and a punchier headline. **Trigger:** `npx tsx scripts/queue-product-refinement.ts <product>` enqueues the `product-seed` job in `refinement` mode; the box then runs the pass on Max. Per-product C-tier creative (headline, static-ad captions, copy corrections) is proposed for one-tap approval; nutrition facts are human-verified per variant before going live.

## Phase 1 — Fan-out to remaining products

Run the pass on **Creamer, Guru, Zen, Creatine, K-Cups, Amazing Coffee** — each harvests its own PDP/Drive/reviews. Each product is an independent, founder-verification-gated box run (one `queue-product-refinement.ts <product>` enqueue per product). Amazing Coffee's single before/after story stays compatible with the legacy `before`/`after` slot (no `before_2`/`after_2`).

### Verification (prod-facing, per product)
- Run the pass on a product → trust pills are individual; timeline centered on desktop; review filter counts are realistic (hundreds, not single digits); each variant has a Supplement Facts panel (HTML) + the AI can quote it on a ticket + it's in the KB; endorsements show real people with **Supabase-hosted** photos; up to 2 before/after stories render with re-hosted photos; hero gallery = 4 slides; headline reads punchy. API console flat (Max).
- Negative: no fabricated endorsements/avatars remain; no Shopify-CDN hotlinks in `product_media`; no nutrition panel ships without human verification.

## Brain updates (same PR set)
[[box-product-seeding]] · [[../lifecycles/product-intelligence]] · [[../tables/product_media]]. On ship, fold into those + delete.