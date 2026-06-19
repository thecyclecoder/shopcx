# Box-driven Product Seeding ⏳

**Owner:** [[../functions/cmo]] · **Parent:** CMO mandate — owned product/website content (grounds [[../lifecycles/product-intelligence]])

Populate a product's **entire** intelligence/content set from near-zero input by **re-hosting the existing [[../lifecycles/product-intelligence]] Engine on the build box** instead of Inngest. The Engine pipeline already exists and is correct — its problem is **runtime**: per-ingredient research over ~16 ingredients + map-reduce over ~2000 reviews + content gen exceed Inngest step limits and get killed by Vercel deploys. The box runs unbounded `claude -p` (Max-billed), so it just *runs the same logic to completion*. Reuse the Engine verbatim; only the **execution host** changes — plus three additions: PDP ingredient auto-extraction, auto benefit-selection from core-desires, and Nano Banana imagery.

**Outcome:** enter (almost) nothing → a fully published product (ingredients → research → review analysis → benefit selections → PDP content → hero/lifestyle/ingredient images), with no per-step babysitting.

## Why the box, not Inngest
The Engine (`src/lib/inngest/product-intelligence.ts`) is sound but unreliable at runtime: `researchIngredients` per-ingredient + `analyzeReviews` over thousands of reviews + `generateContent` are long; Inngest step timeouts + deploy-kills strand runs (e.g. 12 of 16 Superfood Tabs ingredients once stranded). The box already runs long jobs to completion — the right host.

## Mechanism (reuse the box queue)
- New `agent_jobs.kind='product-seed'` claimed via `claim_agent_job(['product-seed'])` into its own lane; `runProductSeedJob(job)` branch in `scripts/builder-worker.ts` (alongside `runJob`/`runPlanJob`/`runFoldJob`).
- Enqueued from `/dashboard/products/[id]/intelligence` ("Auto-populate" button) with just `{ product_id, angle_override? }` — `angle_override` is optional; omitted by default (the box infers the angle from the PDP).
- **Reuse the Engine logic** — factor the four worker bodies out of their Inngest `step.run` wrappers into plain async functions the box calls directly (no nested Inngest, no nested `claude`). Same code path the UI uses; just driven sequentially on the box.

## Input (near-zero — just hit Populate)
- **Ingredients: auto-extracted from the live PDP.** Tested 2026-06-19: the "Clinically Studied Ingredients" chapter is server-rendered HTML at `superfoodscompany.com/products/{handle}` (18 ingredients + descriptions for Ashwavana Guru Focus). The box fetches the page + extracts names/dosages → `product_ingredients`. (Theme access via [[../recipes/..|reconcile-shopify-theme]] is the fallback.) Manual entry still possible if no chapter exists.
- **Angle/positioning: INFERRED from the PDP — no required input.** The page encodes the angle (headline, ingredient-description framing, benefit language — e.g. Guru Focus's ingredients all cluster on focus/cortisol/cognition → a focus/stress angle). The box treats the PDP framing as an **anchor**, then in step 4 strengthens the actual benefit picks by triangulating it against clinical + review evidence (it can improve on the existing angle). The owner can pass an optional `angle_override`, but the default is zero input.
- **Isolated product shots: from the Google Drive asset library** — `Superfoods Company/Assets/Products/{Product}/…` (mapped 2026-06-19). These are the Nano Banana hero source. **Quirks the resolver must handle:** (a) subfolder structure varies per product (`Isolated Product Shots` for Amazing Coffee vs `3D Renders` for Guru Focus) → browse, don't hardcode; (b) files are **per-variant/flavor** (`Amazing Coffee- Pods- front facing product SKU`, `…-Cocoa-…`, `…-Hazelnut-…`; Guru Focus renders are `AswaVANA Orange Passion IFC…`) → match the variant + prefer *front-facing*; (c) **amazing-coffee-pods shots live in the *Amazing Coffee* folder**, named `Pods`; (d) **Pods ↔ K-Cups are interchangeable** (either term matches the other); (e) **multiple flavors + forms per product** in one folder (e.g. Creatine Prime = Black Cherry + Piña Colada, each as a **bag** and a **stick pack**; Guru Focus = bag + stick pack) → the resolver picks the **front-facing bag** as the **primary hero**, keeping stick packs / pods / alternate flavors for single-serve + variant/angle shots. The box must **vision-confirm** it grabbed the correct front-facing isolated packshot for the right variant. (Structure is being standardized on the `Isolated Product Shots` subfolder — created 2026-06-19 for Guru Focus / Zen Relax / Creatine Prime, which lacked it.)
- **Box Drive access (headless):** a **Google Cloud service account** with the **Drive API (read-only)** enabled, and the `Assets/Products` folder **shared to the SA's email (`…@….iam.gserviceaccount.com`) as Viewer**. The box authenticates with the SA JSON key (`files.list` to resolve folders + `files.get?alt=media` to download), stored **AES-256-GCM-encrypted on the workspace** (`google_drive_sa_json_encrypted`) + decrypted via `crypto.ts`. The claude.ai MCP connector used to author/verify this spec is **interactive-only — not available to the headless box**, so the SA is the box's path.

## Pipeline (the Engine, run to completion on the box)
1. **Extract ingredients** from the PDP → `product_ingredients` → `intelligence_status='ingredients_added'`.
2. **`researchIngredients`** (reuse) → `product_ingredient_research` (mechanism, clinical benefits, citations, dosage, contraindications) — fault-isolated per ingredient → `research_complete`.
3. **`analyzeReviews`** (reuse) over `product_reviews` (workspace DB), **4–5★ only, weighting `featured`/`smart_featured` first** (already the Engine's behavior), map-reduce chunks → `product_review_analysis` → `reviews_complete`.
4. **Auto benefit-selection — triangulate three sources, pick the best** (replaces the manual UI step). Synthesize across: (a) **our existing framing** (the PDP angle — an *anchor*, not a ceiling), (b) the **benefits implied by clinical studies** (`product_ingredient_research` → `science_confirmed`), and (c) the **benefits implied by reviews** (`product_review_analysis` → `customer_confirmed`). Choose the lead + supporting benefits that are **strongest across all three** — favoring benefits where clinical evidence and real customer language **converge**, and surfacing a *better* benefit than the current framing when the data supports it (don't just rubber-stamp the existing angle). Each pick carries its evidence (`review IDs` + `ingredient_research IDs`). → `product_benefit_selections` → `benefits_selected`.
5. **`generateContent`** (reuse) → `product_page_content` (hero, mechanism, ingredient cards, comparison, FAQ, guarantee, expectation timeline, endorsements, KB article, support macros) + `product_how_it_works` → `content_generated`.
6. **Nano Banana Pro imagery** (via `src/lib/gemini.ts` `getGeminiCredentials(workspaceId)` → `workspaces.gemini_api_key_encrypted`; **Nano Banana Pro** is the model that produced the approved examples). Per product/variant, generate the **hero** by feeding Nano Banana Pro three inputs: (a) the **isolated front-facing packshot** (product identity, from `{Product}/Isolated Product Shots`), (b) the **`Hero Example` reference set** (`Assets/Products/Hero Example`, id `16uLBC5o3bxSv-PR6i_O9XS5FXMZRZ6xo` — the proven composition/style), and (c) the product's **ingredients + flavor**. **Hero composition — locked pattern:**
   - Clean **white background**; a **flavor-colored powder/dust splash behind the pack that stays *inside* the frame** — no edge cutoffs, so it sits cleanly on white.
   - The **front-facing package** centered.
   - **The prepared drink in a glass** — **coffee + creamer → a hot latte/cappuccino in a clear glass mug**; **every other product (Ashwavana, Creatine Prime, …) → a refreshing *iced* drink in a *tall* glass**, colored to the flavor.
   - A cluster of the **real superfood ingredients** at the base (from `product_ingredients`) + the **flavor element** (e.g. orange + passion fruit for Guru Focus, strawberry for Zen Relax, black cherry / piña colada for Creatine Prime).

   Then **lifestyle + ingredient-callout** images in the same style. All → `product_media`, attached to PDP blocks.
   - **🔒 Never overwrite an approved hero.** **Amazing Coffee, Amazing Coffee K-Cups (pods), and Amazing Creamer already have perfect, locked heroes — the box skips image generation for them entirely.** Hero gen runs ONLY for products missing an approved hero (**Guru Focus, Zen Relax, Creatine Prime**). Idempotent: skip any product/variant whose hero is already approved in `product_media`. (Those two pods/creamer targets may still get *non-image* intelligence — research/reviews/content — but their images are untouchable.)
   - **One variant per hero.** Never composite multiple flavors/variants into a single hero — pick the product's **main/primary variant** and feature only that. Respect **in-stock status**: never hero an out-of-stock/discontinued variant. **Per-product overrides (stock-driven):** **Superfood Tabs → use Peach Mango (orange)** — its Isolated Product Shots include an orange tube, orange box, and orange drink-in-cup, all usable; **do NOT use the Mixed Berry green box (out of stock).**
7. **Auto-publish** → `intelligence_status='published'` (owner's choice — no draft gate). Every stage stays re-runnable (`raw_ai_response` + `*_at` preserved).

## Supervision (North star)
Auto-publishing still answers to a supervisor: each run posts a **summary + the box's reasoning**, every output is **editable in the Engine UI** (the override surface), and the whole run is **re-runnable/replayable**. The box optimizes the bounded proxy (a complete product); the owner owns the objective via the Engine UI.

## Products to complete (canonical targets, by Shopify handle)
The box resolves each via `products.handle` → fetches `superfoodscompany.com/products/{handle}` for the ingredient chapter:
- `ashwavana-guru-focus` · `ashwavana-zen-relax` · `amazing-coffee-pods` · `amazing-creamer` · `creatine-prime`

(`ashwavana-guru-focus`/`zen-relax`/`creatine-prime` probed at `intelligence_status='none'`; variant photos + media already exist. **Amazing Coffee** — the non-pods original — is the done reference, `published`.)

## Tested feasibility (2026-06-19)
- ✅ PDP ingredient chapter readable via plain fetch (server-rendered HTML).
- ✅ Image gen exists — `gemini.ts` (Seedream/Soul) via the per-workspace `gemini_api_key_encrypted`; the key is present in the workspace.
- ✅ `product_reviews` has `rating` + `featured`; Engine already pulls 4★+ featured-first.
- ✅ Engine pipeline + the 7 tables + `intelligence_status` enum all exist — only the host changes.

## Safety / invariants
- **Reuse the Engine logic verbatim** — do not fork the research/review/content logic; factor it to shared functions both the UI (Inngest) and the box call.
- **Box rules:** native tools only, no nested `claude`; Max-billed (no `ANTHROPIC_API_KEY` in env).
- **Reviews:** workspace `product_reviews` only, 4–5★, featured-weighted.
- **Images:** workspace Gemini key (decrypt via `crypto.ts`); never commit keys.
- Re-runnable/replayable; every output editable in the Engine UI.

## Completion criteria
- One "Auto-populate" action on a product → a `product-seed` box job that drives it `none → published`: PDP-extracted ingredients, research, review analysis, core-desire-aligned benefit selections (science+customer confirmed), page content, and Nano Banana hero/lifestyle/ingredient media — unattended. The four target products complete this way; the path matches Amazing Coffee's done state.

## Related
[[../lifecycles/product-intelligence]] · [[../inngest/product-intelligence]] · [[../libraries/gemini]] · [[../tables/products]] · [[../tables/product_ingredients]] · [[../tables/product_reviews]] · [[../tables/product_media]] · [[../tables/agent_jobs]] · [[roadmap-build-console]] · [[../recipes/build-box-setup]]
