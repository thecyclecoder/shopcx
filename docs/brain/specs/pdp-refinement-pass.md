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
The concrete B + C inputs captured 2026-06-20.

**Already applied live (zero-risk DB edits, render with existing code):**
- Headline → **"Fizz. Drink. Shed Pounds & Fight Bloating."**
- Danielle F. review `smart_quote` typo → "I realized I enjoyed them so much, it became a non negotiable."
- Trust pills split to 8 individual items (`certifications` = Non-GMO · 3rd Party Tested · Natural Ingredients; `allergen_free` = Sugar Free · Gluten Free · Soy Free · Dairy Free · Nut Free).

**Pending the P1 build, then the Tabs pass applies:**
- **16 → 15 superfoods** in all copy (hero_subheadline, mechanism_copy, KB, benefit_bar[5], comparison row, faq[0]) **and** the hero credibility badge (the "100mg caffeine (green tea)" card stays but isn't counted as a distinct superfood). NOT the "12–16 oz water" dosing line.
- Real endorsements (Lindsey Ray / Teresa Rodriguez / Brenda Gregory) with photos re-hosted Shopify→Supabase.
- 2 before/after stories (Anne B. — Mixed Berry, 84 lbs — + one more), photos re-hosted.
- 4-slide hero gallery (bag · Drive lifestyle (woman ~40s holding box) · Nano-Banana static-ad · HTML facts).
- Full-corpus 4★+ review analysis (3,122 reviews; real category counts).

**Per-variant Supplement Facts (FINAL — locked; serving = 1 Tablet, 30/container; PDP shows the PRIORITIZED variant = Peach Mango; footer: "*Percent Daily Values are based on a 2,000 calorie diet." + "**Daily value not established."; other ingredients identical across all three: Citric acid, natural flavors, hydroxypropyl cellulose, croscarmellose sodium, rebaudioside A, silica, L-leucine, canola oil and magnesium stearate):**

- **Peach Mango (prioritized):** Calories 5 · Total Carbohydrate <1 g (<1%*) · Sodium (as sodium bicarbonate and sodium carbonate) 230 mg (10%) · Potassium (as potassium bicarbonate) 300 mg (6%) · Proprietary Superfood Blend **400 mg** (**): Turmeric root powder, Green tea leaf extract (100 mg caffeine), Beet root, Elderberry fruit 10:1 extract, Matcha tea leaf (Camellia sinensis), Burdock root 4:1 extract, Ginger root 5:1 extract, Dandelion 5:1 extract (whole plant), Lemon balm 4:1 extract (aerial parts), Milk thistle seed extract, Asian ginseng root, Lycium (goji) fruit 5:1 extract, Pomegranate fruit, Aloe vera inner leaf powder, Organic wheat grass, Chlorella algae.
- **Mixed Berry:** Calories 5 · Total Carbohydrate <1 g (<1%*) · Sodium 230 mg (10%) · Potassium 306 mg (7%) · Proprietary Superfood Blend **457 mg** (**): Elderberry extract, Beet root, Green tea leaf extract (100 mg caffeine), Matcha tea leaf (Camellia sinensis), Burdock root 4:1 extract, Ginger root 5:1 extract, Dandelion 5:1 extract (whole plant), Lemon balm 4:1 extract (aerial parts), Milk thistle seed extract, Asian ginseng root, Lycium (goji) berry fruit 5:1 extract, Pomegranate fruit, Aloe vera inner leaf juice powder, Wheat grass, Chlorella algae.
- **Strawberry Lemonade:** Calories 5 · Total Carbohydrate <1 g (<1%*) · Sodium 240 mg (10%) · Potassium 310 mg (7%) · Proprietary Superfood Blend **467 mg** (**): Organic beet root, Green tea leaf extract (100 mg caffeine), Elderberry fruit extract, Matcha tea leaf (Camellia sinensis), Burdock root 4:1 extract, Ginger root 5:1 extract, Dandelion 5:1 extract (whole plant), Lemon balm 4:1 extract (aerial parts), Milk thistle seed extract, Asian ginseng root, Lycium (goji) berry fruit 5:1 extract, Pomegranate fruit, Aloe vera inner leaf juice powder, Organic wheat grass, Chlorella algae.

**Nano-Banana static-ad caption overlays (FINAL — hook → benefit → social proof, no specific-weight claim on the ad):** `bloat? gone 🫧` · `15 superfoods · one fizzy tab` · `13,000+ love it ★★★★★`.

## Verification

### P1 — global build (code-level, after migrations applied)
- Apply migrations: `npx tsx scripts/apply-pdp-refinement-migrations.ts` → expect `✓ applied 20260620130000_before_after_stories.sql`, `✓ applied 20260620140000_split_trust_pills.sql`. Re-run → same output, no row changes (idempotent).
- After the split migration, in Supabase SQL: `select certifications from products where array_to_string(certifications, '|') ~ ','` → expect **0 rows** (no element still contains a comma).
- On a PDP whose timeline has 4 milestones, view desktop → the row is centered/balanced (4 equal columns), not left-aligned with an empty 5th slot. A 5-step timeline still fills 5 columns.
- On a PDP with `before_1`/`after_1` + `before_2`/`after_2` media and 2 `before_after_stories` → expect two before/after pairs, each beside its own testimonial (quote/name/variant). A PDP with only legacy `before`/`after` still renders one unlabeled pair (Amazing Coffee).
- On a PDP where one ingredient is a caffeine-source duplicate of another (e.g. Tabs: "100mg Caffeine (Green Tea)" + "Green Tea") → the hero credibility badge reads "…on **15 superfoods**…" (duplicate excluded), and the duplicate ingredient card still renders in "Inside every serving".
- Box: `npx tsx scripts/seed-product-tools.ts get-reviews <ws> <pid> 0 100` on a product with >1000 4★ reviews → `total` reflects the **full** corpus (thousands, not capped at 1000/2000); paging `offset` 0,100,200… walks all reviews without repeats.
- Box: `echo '{"sourceUrl":"https://cdn.shopify.com/…/before.jpg","slot":"before_1"}' | npx tsx scripts/seed-product-tools.ts rehost-image <ws> <pid>` → returns a `product-media` Supabase URL; the row's `url` is **not** a Shopify-CDN URL (re-hosted, never hotlinked).
- Ticket/Improve: ask a nutrition question (e.g. "how much sodium is in Peach Mango Tabs?") → the orchestrator calls `get_product_nutrition`; with no populated `supplement_facts` it returns the "no facts on file — don't guess" message (nothing fabricated). After facts are populated + a republish, the KB article contains a "## Supplement Facts (per variant)" section and the tool quotes the exact number.
- `npx tsc --noEmit` → clean.

### Per-product pass (prod-facing, P2/P3)
- Run the pass on a product → trust pills are individual; timeline centered on desktop; review filter counts are realistic (hundreds, not single digits); each variant has a Supplement Facts panel (HTML) + the AI can quote it on a ticket + it's in the KB; endorsements show real people with **Supabase-hosted** photos; up to 2 before/after stories render with re-hosted photos; hero gallery = 4 slides; headline reads punchy. API console flat (Max).
- Negative: no fabricated endorsements/avatars remain; no Shopify-CDN hotlinks in `product_media`; no nutrition panel ships without verification.

## Phases
- ✅ **P1 — global build:** section A landed, tsc-clean. Migrations applied (`20260620130000_before_after_stories.sql`, `20260620140000_split_trust_pills.sql` via `scripts/apply-pdp-refinement-migrations.ts`).
  - **Built:** `WhatToExpectTimeline` centering (cols = min(steps,5)) · `UGCSection`/`BeforeAfterPair` + `before_after_stories` 2-story model (legacy `before`/`after` still works) · `HeroSection` `ResearchCredibility` "N superfoods" badge excludes caffeine-style duplicates · `seed-tools.saveTrustPills` (individual pills) + skill guidance + one-time split migration · `seed-tools.getReviews` range-pagination (no 1000 cap) · `get_product_nutrition` orchestrator tool (improve delegates) + per-variant Supplement-Facts KB mirror in `publishProductContent` · PDP harvest (`getPdpImages` + `rehostImage` — re-host, never hotlink) · gallery slides (`resolveLifestyleSlide` Drive UGC + `generateStaticAdSlide` Nano-Banana w/ caption overlays) + `save-media` displayOrder for gallery rows. All wired into `scripts/seed-product-tools.ts` + the `seed-product` skill.
- ⏳ **P2 — Tabs run:** execute the pass on Superfood Tabs with its C specifics; verify live. **Trigger built:** `npx tsx scripts/queue-product-refinement.ts` (defaults to Superfood Tabs) enqueues the `product-seed` job in `refinement` mode (no UI/CLI path produced one before — the seed API route carries no `mode`). The box then runs the pass on Max, reading the founder-LOCKED Run-#1 inputs above. **Awaiting:** the prod-mutating box run + live verification (prod creds required).
- ⏳ **P3 — fan-out:** run the pass on Creamer, Guru, Zen, Creatine, K-Cups, Amazing Coffee (each harvests its own PDP/Drive/reviews).

## Brain updates (same PR set)
[[box-product-seeding]] (folds in this pass as the refinement mode) · [[../lifecycles/product-intelligence]] · [[../tables/product_media]] (before_2/after_2, endorsement slots, gallery) · [[../tables/sonnet_prompts]]/[[../orchestrator-tools]] (nutrition tool) · [[../lifecycles/help-center]] (KB nutrition mirror) · the seed-product skill page. On ship, fold into those + delete.
