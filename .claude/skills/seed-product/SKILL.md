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
| `generate-image <ws> <pid>` ← stdin `{prompt,imageUrls,slot,aspectRatio}` | Nano Banana Pro → LOCAL file path |
| `save-media <ws> <pid>` ← stdin `{slot,localPath,mimeType,altText}` | upload + persist product_media |
| `publish <ws> <pid>` | publish content + KB + macros, flip to `published` |

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
`hero_headline, hero_subheadline, benefit_bar[4-6], mechanism_copy` (8th-grade,
delivers on every benefit chip in order), `ingredient_cards, comparison_table_rows`
(us vs generic — never name competitors), `faq_items[5-8], guarantee_copy,
knowledge_base_article` (markdown), `kb_what_it_doesnt_do` (explicit limits —
**required**), **`fda_disclaimer`** (the DSHEA "These statements have not been
evaluated by the FDA…" disclaimer — **required**), `support_macros`
(ingredients/dosage/benefits/side_effects/usage), `endorsements` (3 distinct
nutritionists), `expectation_timeline`. Pipe to `save-content`. Then `set-status …
content_generated`. Validate against **Amazing Coffee** (the `published`
benchmark) for structure/completeness — minus linked products + bundles, which
are NOT auto-seeded.

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
`generate-image` (slot `hero`, `imageUrls`=[packUrl, …refUrls], aspectRatio
`1:1`) → it returns a **local file path**. **Read that file** and vision-confirm:
correct in-stock variant (single flavor, not multiple), splash contained on
white, correct drink type, no edge cutoffs. If it fails, re-`generate-image`
with the issues called out (allow ~2 attempts). On pass → `save-media` (slot
`hero`). Then, best-effort (failures never block publish), generate `lifestyle`
and `ingredient` shots in the same style → `save-media`.

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
