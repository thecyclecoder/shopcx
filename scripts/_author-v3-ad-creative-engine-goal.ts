/**
 * Authors the "v3 Ad Creative Engine" GOAL + milestones (via the goals-table SDK), greenlights it,
 * and enqueues a kind='plan' agent_jobs row so Pia decomposes M2+ into a spec tree for the box.
 * Founder-directed 2026-07-21 ("make it a /goal to get the whole thing done").
 *
 * M1 (foundation) is ALREADY BUILT + shipped on branch v3-creative-engine-schema (angle palette +
 * pattern library + compose engine + creamer seed + a validated test-fire). The plan should
 * decompose M2..M7.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { upsertGoal, greenlightGoal } from "../src/lib/goals-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "v3-ad-creative-engine";

const BODY = `
Rebuild the Dahlia/Max/Bianca ad-creative system into a coherent, closed-loop FACTOR MODEL ("quant for media buying"). Designed with the CEO 2026-07-21 (full design: /Users/admin/Desktop/v3-ad-creative-engine.html; running notes: memory project_v3_ad_creative_rework.md).

## The model (layers)
Product -> Ingredient -> THEME (Beauty/Longevity/Healthy-Weight/Energy+Performance/Focus/Gut — the positioning menu + audience tag + coverage axis) -> Problem-ANGLE (demand-sourced via the "why should I take {ingredient}" search sweep; angle carries enemy/mechanism/proof/outcome + evidence_tier + search_demand) -> x PATTERN (~13 shared DR formulas by awareness stage) -> x competitor SKELETON (product-agnostic punch DNA, optional) = HEADLINE. The 5 caption variations = 5 patterns on one angle.

## Design principles (decided — do not re-derive)
- DEMAND selects the angle; scientific evidence REINFORCES it (marketing tools). evidence_tier is a proof STYLE (customer_only -> lead with the review, never a clinical claim), never a filter. product_benefit_selections.role='skip' is NOT a hard exclusion.
- Angles keyed on PROBLEM (one ingredient fans across many problem-lanes). Double-backed problems (2 ingredients) are strongest.
- Read product intel through getProductIntelligence (src/lib/product-intelligence.ts) — never raw .from().
- Skeleton = SCAFFOLD not substance: agnostic wireframe (element x zone x role x prominence) + product-presentation + punchiness tags; per-copy-section REUSE VERDICT computed at AUTHOR time per product (skeleton is product-agnostic).
- Decision engine = FUNCTION-PRESERVING SUBSTITUTION, TEMPERATURE-KEYED: cold strips promo -> value/proof/risk-reversal; warm/hot KEEP the offer slot filled with our REAL offer (getProductIntelligence.offer, Max-verified). Max re-scopes to "substitution supervisor" (no empty slot / honest fill / no leak / on-strategy).
- 3 campaigns: Testing/Prospecting (cold), Scaling (winners), Retarget (ITS OWN lean campaign, one consolidated adset, warm+hot MIXED content: mechanism/reviews/UGC + real-offer promo/risk-reversal).
- Selection: theme-spread (hard, kills convergence) + demand-weighted angle gap-fill + fresh pattern legal for the temperature; filter proven losers, prefer crowned winners. Explore/exploit = continuous blend (~70% fresh / 30% exploit).
- Freshness grain = combination (angle x pattern); cooldown + coverage-before-repetition; pool never starves (hybrid fan-out mints new micro-niches).
- Attribution: STAMP every posted ad {theme, angle, pattern, combination}; a factor-rollup SDK (sibling of testing-results-sdk, grouped by FACTOR) attributes CPA/CTR by pattern/theme/angle with a SIGNIFICANCE gate; factor scores re-weight selection.

## What M1 already shipped (branch v3-creative-engine-schema — do NOT re-plan)
Migration 20261123120000 (product_angle_palette, ad_headline_patterns, ad_creative_combinations, ad_campaigns factor stamps + RLS); SDKs src/lib/ads/{angle-palette,headline-patterns,compose-headline}.ts; the ~13-pattern seed + all 14 Amazing Creamer angles seeded; a validated in-memory test-fire (theme-spread variety, evidence-tier honesty, temperature-correct offers). Brain pages for the 3 tables + 3 libraries.

## Rails (carry into every spec)
De-brand every competitor mark; trace every claim to product intelligence (never fabricate); cold ads carry NO offer; all reads/writes through the SDK chokepoints; every new node ships with owner + kill-switch + heartbeat; code without a brain page is incomplete.
`.trim();

async function main() {
  const res = await upsertGoal(
    WS,
    {
      slug: SLUG,
      title: "v3 Ad Creative Engine",
      owner: "growth",
      proposer_function: "growth",
      status: "proposed",
      outcome:
        "Dahlia authors fresh, on-strategy, demand-sourced ads by crossing a per-product angle palette x a shared pattern library x product-agnostic competitor-skeleton bones — with coverage-driven selection (no mono-angle convergence), temperature-keyed function-preserving substitution, a lean retarget campaign for warm/hot, and factor-attributed learning that re-weights selection from real Meta results.",
      why:
        "Today Dahlia rotates phrasing but always leads with the same lead benefit (mono-angle convergence -> 'basically made the same ad'), the competitor skeleton is taken too literally (Max redo-loop), there's no rotation/coverage memory, and no warm/hot retarget path. Ad-creative quality + variety + retargeting are the top CAC/AOV levers.",
      success_metric:
        "the bin/pins show genuine theme variety (not weight-loss every time); the retarget campaign is live with warm+hot mixed creative; the factor rollup shows which patterns/themes/angles win by CPA; the Max redo-rate on competitor-imitation drops; author-mode beats the prior path on realized cold CAC/CTR in Bianca's loop.",
      body: BODY,
    },
    [
      {
        position: 1,
        title: "M1 — Foundation (angle palette + pattern library + compose engine) [SHIPPED]",
        why: "The data model + authoring core everything hangs on.",
        what: "SHIPPED on branch v3-creative-engine-schema: migration 20261123120000 (product_angle_palette, ad_headline_patterns, ad_creative_combinations, ad_campaigns stamps, RLS); SDKs angle-palette / headline-patterns / compose-headline; ~13-pattern seed + 14 creamer angles; validated test-fire; brain pages. DO NOT re-plan — later milestones build ON this.",
        body: "Reference only. If any gap is found, file a follow-up spec rather than re-authoring M1.",
      },
      {
        position: 2,
        title: "M2 — Wire the engine into Dahlia + seed all 6 products",
        why: "Turn the shipped foundation into the live authoring path, and give every hero product a palette.",
        what: "Selection module (theme-spread + demand-weighted angle gap-fill + fresh angle x pattern combination, legal for temperature, exclude proven losers) reading product_angle_palette + ad_headline_patterns + ad_creative_combinations; wire composeHeadline into Dahlia's author path (behind a flag, prove-before-default) writing the 5 variations = 5 patterns; STAMP each produced ad_campaign with {creative_theme, angle_palette_id, headline_pattern_id, creative_combination_id} and bump combination/angle coverage on use. Hand-seed angle palettes for the other 5 hero products (via the demand sweep + getProductIntelligence, like the creamer seed).",
        body: "Ground against src/lib/ads/{angle-palette,headline-patterns,compose-headline}.ts (shipped M1), creative-agent.ts (author path), builder-worker.ts (box session). Selection extends the coverage ledger + creative-learning.ts.",
      },
      {
        position: 3,
        title: "M3 — Retarget campaign live (warm/hot) [FRONT-LOADED — founder needs soon]",
        why: "The founder needs retargeting ads soon; the compose engine already handles warm/hot correctly (test-fire proved it).",
        what: "Stand up the 3rd campaign — a lean RETARGET campaign (its own budget/audience/optimization), ONE consolidated adset (not split warm/hot — would starve the ~50 events/week learning floor), fed by a MIXED warm->hot creative bin (mechanism/reviews/UGC + real-offer promo/risk-reversal). Wire Bianca to publish the retarget bin to a retargeting audience (site visitors / engagers / cart-adds, not-purchased); the warm/hot compose path keeps the offer slot filled with our REAL offer (getProductIntelligence.offer), Max-verified. Retarget bin draws WARM+HOT patterns; UGC = a product_presentation style.",
        body: "Ground against docs/brain/reference/meta-scaling-methodology.md (the 2-campaign feeder today), media-buyer-publish-gate.md, media-buyer-agent.md. Legacy paused *_rtg-cbo campaigns exist but aren't wired in. Must ship with owner + kill-switch + heartbeat.",
      },
      {
        position: 4,
        title: "M4 — Decision engine + agnostic skeleton redesign",
        why: "Fix the Max redo-loop at the source (skeleton takes competitors too literally) + encode how a skeleton becomes OUR ad.",
        what: "Redesign the competitor skeleton to capture SCAFFOLD not substance — extend creative_skeletons with an agnostic wireframe (elements[] zone+role+prominence), hierarchy/density/text_load, product-presentation (product_visible/prominence/presentation, human_presence), punchiness tags (tone/headline_device/rhythm/word_count_band), and per-copy-section {text, char_count, width_ratio}; DROP prescriptive hook/mechanism_claim/angle from visionDeconstruct. Move the REUSE VERDICT to AUTHOR time (per product, matched against that product's angle table). Implement the function-preserving, temperature-keyed SUBSTITUTION policy (cold strips promo->value/proof; warm/hot keep real offer) and re-scope Max to 'substitution supervisor' (no empty slot / honest fill / no leak / on-strategy).",
        body: "Ground against src/lib/creative-skeleton.ts (visionDeconstruct/VISION_SYSTEM), docs/brain/tables/creative_skeletons.md, libraries/creative-sourcing.md, creative-qa.md (Max). Skeleton is product-agnostic — no product FK, no stored reuse verdict.",
      },
      {
        position: 5,
        title: "M5 — Attribution + learning loop (the 'quant desk')",
        why: "Close the loop: attribute Meta results to factors, re-weight selection, keep the pool fresh.",
        what: "Factor-rollup SDK (sibling of testing-results-sdk.ts, grouped by FACTOR) joining meta_insights_daily to the ad stamps -> CPA/CTR/ROAS by pattern / theme / angle / combination, with a SIGNIFICANCE gate (min spend + conversions before a factor is 'crowned' — never on 3 lucky buys). Feed factor scores back as selection weights (exploit winners, down-weight losers, keep exploring, continuous blend). Freshness rules: never repeat a combination within a cooldown; coverage-before-repetition; retire proven losers; crown winners; hybrid fan-out mints new micro-niches when a theme runs low. Fix the reviews.byClaim() taxonomy mismatch so a benefit resolves its real backing reviews.",
        body: "Ground against src/lib/ads/testing-results-sdk.ts, product-intelligence.ts (reviews.byClaim + reviewAnalysis.top_benefits), creative-learning.ts (recordCombinationGenerated/angleKey).",
      },
      {
        position: 6,
        title: "M6 — Products UI (make the engine visible)",
        why: "The operator needs a window into the whole engine per product.",
        what: "New 'Products' sidebar item under Marketing. (a) LIST view of the 6 hero products + add/remove hero products. (b) Product DETAIL page surfacing everything Dahlia/Max/Bianca use: the benefit trunk + theme->angle->pattern palette (with coverage/status), the proof (reviews/ingredient research/brand proof via getProductIntelligence), the factor-rollup performance (CPA/CTR by theme/angle/pattern), and the live/paused ads + retarget bin.",
        body: "Ground against docs/brain/ui-conventions.md, the existing dashboard/marketing/ads pages, product-intelligence.ts. Owner-gated, read-mostly.",
      },
    ],
  );
  console.log("goal upserted:", res.goal_id, "milestones:", JSON.stringify(res.milestone_ids));

  await greenlightGoal(WS, SLUG, "ceo:dylan");
  console.log("greenlit:", SLUG);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({ workspace_id: WS, spec_slug: SLUG, kind: "plan", status: "queued", instructions: null, created_by: null })
    .select("id")
    .single();
  if (error) throw error;
  console.log("plan job enqueued for Pia:", data.id);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
