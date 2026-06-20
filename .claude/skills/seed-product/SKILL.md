---
name: seed-product
description: Drive ONE product none → published end-to-end on the build box, on Max — PDP ingredient extraction, web-search ingredient research, review analysis, triangulated benefit selection, page content + KB + macros, Nano Banana Pro hero imagery, self-QA, auto-publish. Invoked by the box worker's product-seed job (scripts/builder-worker.ts → runProductSeedJob) as a top-level `claude -p` on Max with web search. Implements docs/brain/specs/box-product-seeding.md.
---

# seed-product

Re-host the Product Intelligence Engine on the box, **on Max**. You are a top-level
`claude -p` launched by the worker with **web search enabled** and **no
`ANTHROPIC_API_KEY`** — every token of LLM work (this reasoning) is Max-billed,
never the Anthropic API. You drive ONE product from `none` → `published`.

## 🔒 Core invariants

- **You do the thinking; the CLI does the I/O.** All reasoning — extracting
  ingredients, **researching each ingredient by SEARCHING THE WEB**, analyzing
  reviews, triangulating benefits, writing the page content, vision-checking the
  hero — is YOUR job, here, on Max. Reach the outside world ONLY through the
  deterministic tool CLI: `npx tsx scripts/seed-product-tools.ts <cmd> …`. Never
  call the Anthropic API; never spawn a nested `claude`.
- **Web search is the research engine.** Ingredient benefits/dosages/
  contraindications come from real web searches (clinical studies, ingredient
  science) with **real citations** — never invented.
- **Supervisable autonomy.** Auto-publish has no human checkpoint, so the
  **self-QA gate (step 7)** is the rail. Fail QA → HOLD at `content_generated`,
  do NOT publish, surface the issue in your final summary.
- **Idempotent + re-runnable.** Every stage skips work already done (ingredients
  kept, approved heroes never overwritten).

## The tool CLI

Run from the repo root. `<ws>` = workspace_id, `<pid>` = product_id (both given
in your prompt). Each command prints ONE JSON object; some read a JSON payload on
stdin (pipe it). On error it prints `{"error":"…"}` and exits 1 — read it and adapt.

| Command | Purpose |
|---|---|
| `product <ws> <pid>` | product (title/handle/target_customer/intelligence_status) + variants (stock) |
| `fetch-pdp <handle>` | live PDP reduced to text (ingredients + angle live here) |
| `set-status <ws> <pid> <status>` | set `intelligence_status` |
| `save-ingredients <ws> <pid>` ← stdin `[{name,dosage_display}]` | insert ingredients (idempotent) |
| `get-ingredients <ws> <pid>` | list (with `id`) — you need the ids for research |
| `save-research <ws> <pid>` ← stdin `[{ingredient_id,benefit_headline,…,citations}]` | persist web research |
| `get-research <ws> <pid>` | research rows (with `id`) — for benefit evidence ids |
| `get-reviews <ws> <pid> [offset] [limit]` | a page of 4–5★ featured-first reviews + `total` |
| `save-review-analysis <ws> <pid>` ← stdin `{analysis,reviews_analyzed}` | persist analysis |
| `get-review-analysis <ws> <pid>` | persisted analysis |
| `save-benefits <ws> <pid>` ← stdin `[{theme_name,role,…,research_ids,customer_review_ids}]` | persist selections |
| `save-content <ws> <pid>` ← stdin `{hero_headline,…,fda_disclaimer}` | insert draft content version |
| `get-content <ws> <pid>` | latest content (for QA) |
| `hero-status <ws> <pid> <handle>` | `{locked, exists}` — skip image gen if either is true |
| `resolve-packshot <ws> <pid> "<name>" "<kw1,kw2>"` | Drive front-facing packshot + Hero Example refs → URLs |
| `generate-image <ws> <pid>` ← stdin `{prompt,imageUrls,slot,aspectRatio,width?,height?}` | Nano Banana Pro → LOCAL file path (pads to `width`×`height` on white when given) |
| `pull-ingredient-images <ws> <pid> <handle>` | download REAL per-ingredient PDP CDN images, match by name → `product_media` slot=`ingredient_{name}` @400×400 |
| `ingredient-images-fallback <ws> <pid>` ← optional stdin `[{name,visual_description}]` | Nano Banana Pro studio photo ONLY for ingredients still missing a pulled PDP image → `product_media` slot=`ingredient_{name}` @400×400 (PDP pull stays preferred) |
| `get-media <ws> <pid>` | existing `product_media` slots (with urls) — to find which chapter images (lifestyle_1 / timeline_N) are missing |
| `save-media <ws> <pid>` ← stdin `{slot,localPath,mimeType,altText}` | upload + persist product_media |
| `publish <ws> <pid>` | publish content + KB + macros, flip to `published` |

## Media-refresh mode

If your prompt says **MEDIA-REFRESH mode** (params `"mode":"media-refresh"`), run
**ONLY the image stages** — **step 6** (hero + lifestyle) and **step 6b**
(PDP ingredient pull + the Nano Banana Pro ingredient fallback) — on an
already-`published` product. **Skip** web research,
review analysis, benefit selection, and content (steps 1–5), and **do NOT change
`intelligence_status`** (no `set-status`). Still honor the locked-hero guard
(never regenerate the 3 locked heroes; you *may* still add their
`ingredient_{name}` images). Start with `product <ws> <pid>` for the variant list,
then go straight to step 6. End with the same final JSON.

## Content-refresh mode (round-3 lander refinements)

If your prompt says **CONTENT-REFRESH mode** (params `"mode":"content-refresh"`),
**keep** the existing research / reviews / benefit selections (do NOT redo steps
1–4) and re-author the page content with the round-3 refinements, then refresh the
chapter images. Steps:
1. `product <ws> <pid>` (title/handle/variants) + `get-content`, `get-benefits`,
   `get-research`, `get-review-analysis` to ground the rewrite in the existing
   evidence (still cite it — do NOT invent new benefits).
2. **Re-author content** (step 5) with the round-3 emphasis: a **punchier,
   benefit-first `hero_headline`** (per the per-product direction), the right
   **`comparison_competitor_label`** + matching `comparison_table_rows`, and
   **`show_survey`** (`true` only for `amazing-coffee`/`amazing-coffee-pods`, else
   `false`). Carry the rest of the content forward faithfully (benefit_bar,
   ingredient_cards, faq, kb, **fda_disclaimer**, kb_what_it_doesnt_do,
   endorsements, expectation_timeline). `save-content` writes a new draft version.
3. **Refresh chapter images** (step 6 + "Missing chapter images") — hero (honor
   the locked-hero guard), `lifestyle_1`, `timeline_N` (if the timeline renders),
   and the `ingredient_{name}` set (step 6b pull + fallback). **Never** generate
   endorsement avatar faces.
4. **Self-QA** (step 7), then **`publish`** to promote the refreshed version (the
   product is already published — this re-publishes the new content). Do NOT call
   `set-status` yourself; `publish` handles it.
End with the same final JSON.

## Pipeline (run to completion)

First: `product <ws> <pid>`. Note title, handle, target_customer, current
`intelligence_status`, and the variant list (titles + `available` +
`inventory_quantity` + position). If `intelligence_status` is already
`published`, do the idempotent checks but don't redo finished work.

### 1 — Ingredients (from the live PDP)
`fetch-pdp <handle>`. Find the clinically-studied / key-ingredients section
(titles vary: "Clinically Studied Ingredients", "Key Ingredients", "What's
Inside", "Supplement Facts"). Extract the real functional ingredients in order —
name (no dosage in the name) + `dosage_display` (the stated amount, e.g. "600mg",
"5g", "10 billion CFU", or null). Skip "other ingredients", flavorings,
anti-caking agents, marketing words. Never invent dosages.
Pipe them to `save-ingredients`. If it returns `added:0, existing:0` (no chapter,
nothing already there) → **HOLD**: report "no ingredients (PDP chapter missing)".
Then `set-status … ingredients_added`.

### 2 — Ingredient research (WEB SEARCH, on Max)
`get-ingredients` for the ids. For EACH ingredient, **search the web** for
clinical studies on its benefits at the product's dosage for `target_customer`:
mechanism, effective dosage range (and how the product dose compares),
contraindications. Capture **real citations** (title/authors/journal/year/doi/
url). Surface ALL proven benefits (the angle later decides which to foreground);
be conservative with `ai_confidence` (1.0 multiple RCTs · 0.8 single RCT · 0.7
meta-analysis/observational · 0.5 observational · 0.3 traditional · 0.1
theoretical). Pipe an array of research rows (each with `ingredient_id`) to
`save-research`. A row with no citation is not research — find one or drop it.
Then `set-status … research_complete`. (Fault-isolate: if one ingredient yields
nothing solid, continue the rest.)

### 3 — Review analysis
`set-status … analyzing_reviews`. Page through `get-reviews` (note `total`; pull
in chunks of ~100 until you've covered them, capping at a sensible amount for a
faithful read — featured + 5★ first). Analyze in YOUR context:
- `top_benefits`: `[{benefit, frequency, customer_phrases[], review_ids[]}]`
- `before_after_pain_points`: `[{before, after, review_ids[]}]`
- `skeptic_conversions`: `[{summary, quote, review_id, reviewer_name}]`
- `surprise_benefits`: `[{benefit, quote, review_id}]`
- `most_powerful_phrases`: `[{phrase, context, review_id, reviewer_name}]`
**Every quote MUST be an exact substring of that review's body; every review_id
must be a real id you saw.** Pipe `{analysis, reviews_analyzed}` to
`save-review-analysis`. Then `set-status … reviews_complete`. (No reviews → save
the empty shape and continue.)

### 4 — Triangulated benefit selection
Triangulate THREE sources and pick the strongest:
(a) **our framing** — the PDP angle (an *anchor*, not a ceiling; you may pass
`angle_override` from your prompt instead),
(b) **science** — `get-research` (benefits clinical evidence supports),
(c) **customers** — `get-review-analysis` `top_benefits`.
Group into unified benefit themes. Favor themes where **clinical evidence and
real customer language converge**; surface a BETTER benefit than the current
angle when the data supports it (don't rubber-stamp). Mark 1–3 strongest as
`lead`, solid secondaries `supporting`, weak/unsupported `skip`. **Each kept pick
must carry its evidence**: `research_ids` (from `get-research`) and/or
`customer_review_ids` (from the analysis). Pipe the themes to `save-benefits`. If
it returns `lead:0` → **HOLD** at `reviews_complete`. Else `set-status …
benefits_selected`.

### 5 — Page content
`set-status … generating_content`. Author the full page content as a JSON object
for `save-content`. Base the hero + benefit_bar on the **selected benefits**; use
exact customer phrases for outcome language; tie every claim to evidence; never
claim a benefit with confidence < 0.5 as primary. Plain outcome language, not
clinical jargon. Include:
`hero_headline` (**tight, scannable, benefit-first** — lead with the ONE benefit
the customer most wants, from the `lead` selections; match Amazing Coffee's style
*"Brew. Sip. Shed Pounds & Fight Aging."* — short punchy clauses, not a sentence),
`hero_subheadline, benefit_bar[4-6], mechanism_copy` (8th-grade,
delivers on every benefit chip in order), `ingredient_cards, comparison_table_rows`
(us vs generic — never name a brand) + **`comparison_competitor_label`** (the rival
*category* the comparison chapter compares against — pick the RIGHT one per the
table below; null falls back to "Regular Coffee", correct only for coffee),
**`show_survey`** (boolean — `true` ONLY for the coffee products
`amazing-coffee` / `amazing-coffee-pods`; **`false` for everything else** — the
survey chapter is hardcoded coffee-specific), `faq_items[5-8], guarantee_copy,
knowledge_base_article` (markdown), `kb_what_it_doesnt_do` (explicit limits —
**required**), **`fda_disclaimer`** (the DSHEA "These statements have not been
evaluated by the FDA…" disclaimer — **required**), `support_macros`
(ingredients/dosage/benefits/side_effects/usage), `endorsements` (3 distinct
nutritionists), `expectation_timeline`. Pipe to `save-content`. Then `set-status …
content_generated`. Validate against **Amazing Coffee** (the `published`
benchmark) for structure/completeness — minus linked products + bundles, which
are NOT auto-seeded.

**`comparison_competitor_label` + contrast rows — compare against the RIGHT thing**
(craft `comparison_table_rows` `us`/`competitor_generic` from these contrasts):
- **Ashwavana Guru Focus** → **"Coffee & Energy Drinks"**: clinically-studied
  adaptogens (Ashwagandha/Rhodiola) vs synthetic caffeine · calm no-jitters energy
  vs spike-and-crash · supports mood + stress vs just a buzz · no sugar.
- **Ashwavana Zen Relax** → **"Melatonin & Sleep Aids"**: adaptogens calm stress at
  the root vs sedate · no morning grogginess · non-habit-forming · caffeine-free.
- **Creatine Prime** → **"Plain Creatine"**: 5g creatine + Rhodiola (body + mind) vs
  creatine alone · delicious Black Cherry vs chalky/flavorless · mixes clean, no
  grit/bloat.
- **Superfood Tabs** → **"Sugary Sports Drinks"**: real superfoods + cleanse vs sugar
  + dyes · zero sugar · portable tablet vs bulky bottle.
- **Amazing Creamer** → **"Regular Creamer"**: collagen + beauty actives vs sugar +
  seed oils · supports skin/anti-aging · clean, no crash.
- **Amazing Coffee / K-Cups** → keep "Regular Coffee" (set the label or leave null).

**Hero headline direction per product** (craft the final copy from the real
benefits/reviews — keep it short + benefit-first):
- **Guru Focus**: razor focus + clean all-day energy, **zero jitters/crash**.
- **Zen Relax**: melt stress + deep sleep + wake restored (**caffeine-free** wind-down).
- **Creatine Prime**: stronger + sharper + **actually delicious** (5g creatine, no chalk).
- **Superfood Tabs**: **cleansing hydration + energy** in one tablet.
- **Amazing Creamer**: creamy coffee + **collagen beauty/glow**.
- **Amazing Coffee / K-Cups**: keep the existing headline (already strong).

### 6 — Nano Banana Pro hero imagery
`hero-status <ws> <pid> <handle>`. If `locked` (Amazing Coffee / Amazing Coffee
pods / Amazing Creamer) **or** `exists` → **SKIP image gen entirely** (record
"hero: skipped (locked/approved)"); never overwrite an approved hero.
Otherwise, pick **ONE** variant — the **primary in-stock** one (respect
`available`/`inventory_quantity`; never an out-of-stock/discontinued variant).
**Per-product override:** **Superfood Tabs → use Peach Mango (orange)** (orange
tube/box/drink); do NOT use the Mixed Berry green box (out of stock).
`resolve-packshot <ws> <pid> "<title>" "<variant keywords>"` to get the
front-facing packshot URL + Hero Example ref URLs (it vision-prefers the
front-facing bag). Build the hero prompt for the **locked composition**:
- clean **white background**;
- a **flavor-colored powder/dust splash behind the pack that stays fully INSIDE
  the frame** (no edge cutoffs);
- the **front-facing package centered**;
- the **prepared drink in a glass** — **coffee/creamer → a hot latte/cappuccino
  in a clear glass mug**; **everything else → a refreshing ICED drink in a TALL
  clear glass**, colored to the flavor;
- a cluster of the **real superfood ingredients** at the base + the flavor
  element (e.g. orange + passion fruit for Guru Focus, strawberry for Zen Relax,
  black cherry / piña colada for Creatine Prime).
Tell it: use the FIRST image as the exact package identity (don't redesign the
label), the rest only for composition/style; ONE variant only.
`generate-image` (slot `hero`, `imageUrls`=[packUrl, …refUrls], **aspectRatio
`4:3`, `width` 1800, `height` 1344** — the **landscape** gallery size; a square
hero gets cut off in the storefront gallery, and the tool pads a near-aspect
render to exactly 1800×1344 on white) → it returns a **local file path**. **Read
that file** and vision-confirm: correct in-stock variant (single flavor, not
multiple), splash contained on white, correct drink type, no edge cutoffs, proper
landscape framing. If it fails, re-`generate-image` with the issues called out
(allow ~2 attempts). On pass → `save-media` (slot `hero`). Then, best-effort
(failures never block publish), generate a `lifestyle_1` shot in the same style
— an **in-use lifestyle shot** of the prepared drink (this is the HowItWorks
chapter image; the page reads slot **`lifestyle_1`**, not `lifestyle`), also
landscape `4:3` / 1800×1344 → `save-media` (slot `lifestyle_1`).

### 6 (cont.) — Missing chapter images (round 3)
Some image-bearing chapters that APPLY render blank when their media slot is
empty. Fill the MISSING ones from the same isolated packshot (consistent studio
style). First `get-media <ws> <pid>` to see which slots already exist — **only
generate the ones still missing** (idempotent). Generate, best-effort:
- **`lifestyle_1`** — the HowItWorks in-use shot (covered just above; generate it
  here if you skipped it / it's missing).
- **`timeline_1..N`** — ONE per `expectation_timeline` milestone, **only if the
  timeline renders** (you authored a non-empty `expectation_timeline`). Each is a
  small square-ish bubble image evoking that milestone's moment with the product
  (slot `timeline_{N}`, N = 1-based milestone index; `1:1`, ~400×400). Skip
  entirely if there's no timeline.
- **🚫 Do NOT generate `endorsement_*_avatar` faces** — fake AI expert headshots
  are a misleading-endorsement risk. Leave them blank (they need real expert
  photos — flag for the owner). Also **SKIP** `before`/`after` (weight-loss UGC,
  coffee-only) and `survey_q*` (survey hidden for non-coffee).
Use the same `generate-image` → `save-media` flow; vision-check each is on-brand
before saving. All best-effort — failures never block publish.

### 6b — Per-ingredient images FROM the PDP (real CDN images, NOT Gemini)
The PDP's ingredient section serves real per-ingredient CDN images named by
ingredient (e.g. `Ashwagandha_1.jpg`, `Beet_Root.jpg`, `Chlorella.jpg`,
`Grape_Seed_Extract.jpg`, `D3_1.jpg`). **Do NOT generate these with Gemini** —
pull the real ones: run `pull-ingredient-images <ws> <pid> <handle>`. It matches
each PDP image to a `product_ingredient` by name, downloads it, normalizes to
400×400, and writes `product_media` slot=`ingredient_{snake_name}` (matching
Amazing Coffee). Read the returned `{matched, unmatched, pdp_images}`.

**Then — Nano Banana Pro FALLBACK for any ingredient with NO PDP image.** Some
ingredients have no per-ingredient photo on the PDP (e.g. Creatine Prime's
Creatine Monohydrate + Rhodiola) → they'd be left as blank cards. For those, pipe
a `[{name, visual_description}]` array to `ingredient-images-fallback <ws> <pid>`,
where `visual_description` is the ingredient in its **natural/raw recognizable
form** (you know this from your step-2 research — e.g. creatine = "fine white
crystalline powder in a small scoop", rhodiola = "dried golden-brown rhodiola
root pieces", a botanical = "the dried herb/root/berry"). The tool generates a
clean studio photo on a pure white background, normalizes to 400×400 to match the
pulled PDP thumbnails, and writes `product_media` slot=`ingredient_{snake_name}`.
**It generates ONLY for ingredients still missing an image — the PDP pull stays
the default/preferred source and is never overwritten** (the tool skips any
ingredient that already has a row). Pass descriptions for **every** ingredient you
saw in `unmatched` (extras are harmless — already-imaged ones are skipped). Read
the returned `{generated, skipped, failed}` and note it in your final summary.
Best-effort — failures here never block publish.

### 7 — Self-QA gate (the rail before auto-publish)
HOLD (do NOT publish; leave at `content_generated`) and report the issue if ANY:
- the hero was generated but failed vision-QA;
- a `lead`/`supporting` benefit has no evidence (no research/review ids) — check
  `get-benefits`;
- the `fda_disclaimer` is missing/empty, or `kb_what_it_doesnt_do` is missing —
  check `get-content`;
- an out-of-stock variant was featured.
All pass → continue.

### 8 — Auto-publish (only on QA pass)
`publish <ws> <pid>` (publishes content, creates inactive macros + the KB
article, flips `intelligence_status` → `published`). On `{ok:false}` → HOLD with
the error.

## Final output

End with EXACTLY one JSON object (your supervision summary — the worker posts it
back on the job and decides completed vs needs_attention):

- Published: `{"status":"completed","summary":"<title> → published. <steps + reasoning: ingredients, research, reviews, benefits lead/supporting, content version, hero generated/skipped, QA passed>"}`
- Held (QA fail / missing data / publish error): `{"status":"needs_attention","summary":"HELD at <status>: <the issue + why>. <what was done so far>"}`

Surface your reasoning in the summary (the supervision hook) — what benefits you
chose and why, any web-research gaps, why a hero was skipped/held. Everything you
wrote stays editable in the Engine UI.
