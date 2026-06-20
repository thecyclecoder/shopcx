# `src/lib/product-intelligence/*` — the Engine core + box seeding tools

Two **separate** Product Intelligence paths ([[../specs/box-product-seeding]]):

1. **UI/Inngest Engine — the Anthropic API path.** `engine.ts` holds the heavy
   bodies; [[../inngest/product-intelligence]] wraps each in a `step.run`. All
   LLM via the Anthropic Messages API (`process.env.ANTHROPIC_API_KEY`).
2. **Box product-seed — the Max path.** A `kind='product-seed'` job
   (`runProductSeedJob` in `scripts/builder-worker.ts`) launches a **top-level
   `claude -p` on Max** (web search, **no `ANTHROPIC_API_KEY`**) running the
   **`seed-product` skill**. That Claude does ALL the reasoning agentically
   (ingredient extraction, **web-search ingredient research**, review analysis,
   benefit triangulation, content authoring, hero vision-QA) and reaches the
   outside world ONLY through the deterministic tool CLI
   `scripts/seed-product-tools.ts` → `seed-tools.ts`. **No Anthropic API on the
   box, no per-token spend.**

These do NOT share LLM code — only the deterministic `publish.ts`. (PR #106 first
built the box path as in-process Anthropic-API calls; the follow-up moved it to
Max + web search.)

## `engine.ts` — UI/Inngest API path

| Export | Notes |
|---|---|
| `callSonnet(system, user, maxTokens, temp)` | Anthropic Messages API (`process.env.ANTHROPIC_API_KEY`, model [[../libraries/ai-models\|SONNET]]). Used ONLY by the Inngest Engine — never the box |
| `extractJson<T>(text)` | tolerant JSON extraction (fences / substring salvage) |
| `researchOneIngredient(admin, {…})` · `researchIngredientsCore(admin, {…})` | per-ingredient research → `product_ingredient_research`, fault-isolated |
| `fetchReviewsForAnalysis` · `analyzeReviewChunk` · `reduceReviewAnalysis` · `persistReviewAnalysis` · `analyzeReviewsCore` | 4–5★, featured-weighted, 100-review map-reduce → `product_review_analysis` |
| `generateContentCore(admin, {…})` | fetch context → Sonnet → insert a new draft `product_page_content` version |

## `seed-tools.ts` — box deterministic tools (🚨 NO Anthropic API)

The I/O helpers the `seed-product` skill calls (via the CLI). Pure deterministic
work — PDP fetch, DB reads/writes, Drive (SA) packshots, the Gemini image API,
publish. The skill does the thinking; these do the I/O.

| Export | Step | Notes |
|---|---|---|
| `getProduct` / `setStatus` | — | product + variants (stock); `intelligence_status` writes |
| `fetchPdpText(handle)` | 1 | live PDP → reduced text (ingredients + angle) |
| `saveIngredients` / `getIngredients` | 1 | persist extracted ingredients (idempotent — keeps existing) |
| `saveResearch` / `getResearch` | 2 | persist web-search research (real citations) → `product_ingredient_research`; per-ingredient clean-replace |
| `getReviews` (paged) / `saveReviewAnalysis` / `getReviewAnalysis` | 3 | 4–5★ featured-first reviews; the skill analyzes, this persists → `product_review_analysis` |
| `saveBenefits` / `getBenefits` | 4 | persist triangulated themes (validates evidence IDs) → `product_benefit_selections` |
| `saveContent` / `getContent` | 5 | version + persist authored content (incl. `fda_disclaimer`) → `product_page_content` |
| `heroStatus` | 6 | `{locked, exists}` — `LOCKED_HERO_HANDLES` (amazing-coffee, -pods, -creamer) + already-has-hero ⇒ skip |
| `resolvePackshot` | 6 | [[google-drive]] front-facing packshot + `Hero Example` refs → storage URLs |
| `generateImage` | 6 | [[gemini]] `generateNanoBananaProCombine` → a **local file** the skill Reads to vision-QA; pads to `width`×`height` on white when given (heroes → `HERO_WIDTH`×`HERO_HEIGHT` = 1800×1344, `HERO_ASPECT` `4:3`) |
| `saveMedia` | 6 | upload a vision-approved image → `product_media` (records `width`/`height`/`file_size` via sharp) |
| `pullIngredientImages` | 6b | pull REAL per-ingredient PDP CDN images (Ashwagandha_1.jpg…), match by name, normalize to `INGREDIENT_SIZE` 400×400 → `product_media` slot=`ingredient_{snake}`. NOT Gemini. Idempotent; `{matched, unmatched, pdp_images}` |
| `publish` | 8 | delegates to `publish.ts` |

**Image refinements (round 2):** heroes render **landscape 1800×1344** (`HERO_ASPECT`
`4:3` to Nano Banana Pro, then `fitOnWhite` pads a near-aspect render to exact
size — square heroes were cut off in the storefront gallery). Per-ingredient
images come **from the PDP**, not Gemini — `pullIngredientImages` extracts
Shopify-CDN URLs (`extractPdpImages`), matches filenames to ingredient names, and
writes `product_media` slot=`ingredient_{snake}` at 400×400.

**Ingredient-image extraction + matching (fixed):** `extractPdpImages` matches
**both** the live storefront CDN path (`superfoodscompany.com/cdn/shop/files/…`,
what the PDPs actually serve) **and** the legacy `cdn.shopify.com` host — the
earlier regex only matched the latter, so real PDPs returned `pdp_images:0` (blank
ingredient cards). Filename↔ingredient matching is **token-based**: both sides are
lowercased into alphanumeric tokens; generic descriptors + PDP prefixes
(`vitamin`, `extract`, `oil`, `acid`, `root`, `ingredient`, `creamer`, …) are
dropped so the **distinctive** token drives the match (`Vitamin D3`→`d3`, `MCT
Oil`→`mct`, `Hyaluronic Acid`→`hyaluronic`, `Beet Root`→`beet`). An image matches
when **every** distinctive ingredient token appears in (or as) a filename token
(containment requires the contained side ≥3 chars, so a stray 1–2-char filename
token can't spuriously match). This handles divergent PDP conventions —
`Ashwagandha_1.jpg` (TitleCase_underscore) and `creamer-ingredient-collagen.jpg`
(lowercase-dashed-prefixed) alike. **`media-refresh`
mode** (`agent_jobs` instructions `{product_id, mode:"media-refresh"}`) re-runs
ONLY the image stages (step 6 + 6b) on a published product — `runProductSeedJob`
builds a media-refresh prompt; the skill skips research/reviews/content and never
touches `intelligence_status` (still honoring the locked-hero guard).

## `scripts/seed-product-tools.ts` — the tool CLI

Thin argv dispatcher over `seed-tools.ts` (loads env via `_bootstrap`). Each
subcommand prints ONE JSON object (or `{"error":…}` + exit 1); some read a JSON
payload on stdin. The `seed-product` skill is its only caller.

## `.claude/skills/seed-product/` — the Max skill

The agentic procedure the box's `claude -p` runs: pipeline steps 1–8, the locked
hero rules (skip locked/approved; one in-stock variant; **Superfood Tabs → Peach
Mango**), the self-QA gate, auto-publish, and the final supervision JSON.

## `publish.ts` — step 8 (shared, deterministic)

`publishProductContent(admin, {workspace_id, product_id, contentId})` → support
macros (inactive) + KB article upsert + `status='published'` +
`intelligence_status='published'`. Called by **both** the box (`seed-tools.publish`)
and the `page-content/[id]/publish` route.
