# PDP Refinement Pass (repeatable per-product polish) ⏳

**Owner:** [[../functions/cmo]] · **Parent:** CMO mandate — owned product/website content (extends [[box-product-seeding]]; runs on the same box/Max substrate). Derived from the Superfood Tabs refinement session (2026-06-20) — codified so it runs on **every** product without re-specifying.

A **repeatable refinement pass** the box runs on an already-published PDP to bring it to the "looks fantastic" bar we hand-tuned on Superfood Tabs. The founder should **never re-type these fixes per product** — this spec is the workflow; running it per product is the fan-out. It splits into **(A) one-time global code/pipeline upgrades** (build once, every product benefits) and **(B) a per-product pass** the box executes (mostly auto-harvested from each product's own live Shopify PDP + Drive + reviews), plus **(C) per-product creative** the pass proposes for one-tap approval.

**Outcome:** run the pass on any product → its PDP gets individual trust pills, a centered timeline, full-corpus review analysis, per-variant Supplement Facts (HTML, AI- + KB-readable), real harvested nutritionist endorsements (photos re-hosted), up to 2 before/after stories (photos re-hosted), a 4-slide hero gallery (bag + Drive lifestyle + Nano-Banana static-ad + facts), and a punchier headline — identical quality to Tabs, zero re-typing.

## A. Global upgrades (build once — code / skill / pipeline)
Each benefits every product; ship in one build (PR), then the per-product pass applies the data.
1. **Timeline centering** — `WhatToExpectTimeline.tsx`: desktop columns = `min(steps,5)` so <5 steps center instead of left-aligning in a fixed 5-col grid. (Tabs/K-Cups had 4 → off-center.)
2. **Before/after → 2 stories** — expand the single `before`/`after` slot pair + `UGCSection` to `before_1/after_1` + `before_2/after_2`, each with its own testimonial (quote/name/variant). Amazing Coffee's single story stays compatible.
3. **"15 vs 16" credibility badge** — `HeroSection` `ResearchCredibility` counts distinct *superfoods*, excluding caffeine-style duplicates of an existing ingredient (Tabs: the "100mg caffeine (green tea)" card duplicates Green Tea → count 15, card kept).
4. **Trust pills as individual items** — the seed skill's content step must emit `certifications`/`allergen_free` as **one item per array element** (never a comma-joined string), and a one-time split of existing products' arrays.
5. **Review analysis over the FULL 4★+ corpus** — `seed-tools.ts get-reviews` → **range-based pagination** (`.range()`), no `.limit(2000)` cap, dodging the PostgREST 1000 `max-rows` ceiling; skill pages through **all** 4★+ reviews (featured-first for weighting), no sampling. Drives real category counts (Tabs had 3,122 4★+ reviews but pills showed 1–4).
6. **Per-variant Supplement Facts as data** — populate `product_variants.supplement_facts` (existing column/HTML renderer) per variant; PDP shows the **prioritized variant** (hero gallery facts slide + FAQ `SupplementFactsSection`); linked products show multiple. Add a **per-variant nutrition tool to the orchestrator** (`sonnet-orchestrator-v2` + `improve-tools`) so the ticket handler can answer nutrition questions, and **mirror facts into the KB**.
7. **Harvest-from-Shopify-PDP seed step** — fetch the product's live `superfoodscompany.com/products/{handle}` and extract: **real nutritionist endorsements** (name/credentials/quote/bullets) and **before/after stories** (images + testimonials). **Re-host all images Shopify→Supabase** (download + upload to `product-media/{pid}/`, e.g. `endorsement_{n}_avatar`, `before_{n}`/`after_{n}`) — **never hotlink the Shopify CDN**. Replaces any fabricated AI endorsements/avatars.
8. **Gallery slides** — beyond the bag hero: a **Drive lifestyle slide** (resolve from `…/{Product}/UGC/Photos`, prefer real-customer / target-demo, crop to the locked 1800×1344), and a **Nano-Banana Pro static-ad slide** (top-down kitchen counter, hand holding the prioritized-variant pack + a made drink, with **caption overlays** in the style of a winning static ad). Added as extra `slot="hero"` gallery rows.

## B. Per-product pass (the box runs — auto-harvested, no re-typing)
A `content+media refresh`-style run ([[box-product-seeding]] modes) that, for the target product:
- Splits trust pills to individual items; re-runs review analysis over the full 4★+ corpus (real category counts); populates per-variant `supplement_facts` from the product's real labels; harvests + re-hosts real endorsements and before/after stories from its Shopify PDP; generates the lifestyle + static-ad gallery slides; ensures the timeline renders centered.
- Everything is sourced from **that product's own** PDP / Drive / reviews — so one workflow covers all products.

## C. Per-product creative (pass proposes → one-tap approve)
- **Punchier benefit-first headline** (Tabs: "Fizz. Drink. Shed Pounds & Fight Bloating.").
- **Static-ad caption copy** for the Nano-Banana slide (pulled from the review corpus).
- **One-off copy corrections** the pass flags (e.g. Tabs "16→15 superfoods" everywhere except the "12–16 oz water" dosing line; a truncated review `smart_quote` like "t realized…" → "I realized…").
- **Nutrition facts must be human-verified** per variant before going live (factual/compliance) — the pass surfaces its transcription for approval.

## Run #1 — Superfood Tabs (the source of this workflow)
Tabs carries the concrete instances of B + C captured 2026-06-20: headline above; 16→15; Danielle F. `smart_quote` fix; 8 individual pills; 3-variant supplement facts (Peach Mango prioritized — Sodium 230/Potassium 300/Blend 400mg; Mixed Berry 230/306/457; Strawberry Lemonade 240/310/467 — **pending founder verification**); real endorsements (Lindsey Ray / Teresa Rodriguez / Brenda Gregory, photos re-hosted); 2 before/after stories (Anne B. + one more); 4-slide gallery; full-corpus review analysis.

## Verification
- Run the pass on a product → trust pills are individual; timeline centered on desktop; review filter counts are realistic (hundreds, not single digits); each variant has a Supplement Facts panel (HTML) + the AI can quote it on a ticket + it's in the KB; endorsements show real people with **Supabase-hosted** photos; up to 2 before/after stories render with re-hosted photos; hero gallery = 4 slides; headline reads punchy. API console flat (Max).
- Negative: no fabricated endorsements/avatars remain; no Shopify-CDN hotlinks in `product_media`; no nutrition panel ships without verification.

## Phases
- ⏳ **P1 — global build:** ship section A (components + skill + seed-tools + orchestrator tool + KB + harvest step), tsc-clean, PR.
- ⏳ **P2 — Tabs run:** execute the pass on Superfood Tabs with its C specifics; verify live.
- ⏳ **P3 — fan-out:** run the pass on Creamer, Guru, Zen, Creatine, K-Cups, Amazing Coffee (each harvests its own PDP/Drive/reviews).

## Brain updates (same PR set)
[[box-product-seeding]] (folds in this pass as the refinement mode) · [[../lifecycles/product-intelligence]] · [[../tables/product_media]] (before_2/after_2, endorsement slots, gallery) · [[../tables/sonnet_prompts]]/[[../orchestrator-tools]] (nutrition tool) · [[../lifecycles/help-center]] (KB nutrition mirror) · the seed-product skill page. On ship, fold into those + delete.
