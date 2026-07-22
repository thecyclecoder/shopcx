/**
 * seed-angle-palette — the ONE generic seeder that turns a product's intelligence + ingredient
 * profile + the demand-sweep provider into a first-cut `product_angle_palette` for any hero SKU.
 *
 * The v3 goal wires Dahlia's author path to `product_angle_palette` (M1) and the selection engine
 * (M2). Both starve on any product with no palette — the wired author path silently falls back to
 * the pre-M1 inlined path, and the selection engine escalates on 'selection_pool_exhausted'. This
 * seeder closes that gap: it drafts a palette for every advertised product using
 *   1. `getProductIntelligence` for ingredients (SDK, never raw .from()),
 *   2. `listAdvertisedProductIds` as the advertised-products chokepoint (a non-advertised product
 *      cannot be seeded — the north-star rail: hero product gate is the source of truth),
 *   3. `fetchSearchDemand` for the tier (evidence-grounded, never by fiat), and
 *   4. `upsertAngle` with `source='seeded'`, `isActive=false` (owner-gated — no autopilot enters
 *      an ad rail without human sign-off; the operator promotes via `/dashboard/marketing/ads/angles/[productId]`).
 *
 * The enumeration lives in `PROBLEM_LANES` below — one table, edited in git, so every hero
 * product's palette lands on the same schema. Adding a 7th hero is one CLI invocation.
 *
 * Spec: docs/brain/specs/seed-angle-palette-remaining-5-products.md · Phase 1.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSearchDemand, type SearchDemandRecord } from "./angle-demand-sweep";
import {
  upsertAngle,
  type AngleTheme,
  type EvidenceTier,
  type ProductAngle,
} from "./angle-palette";
import { isAdvertisedProduct } from "@/lib/advertised-products";
import { getProductIntelligence } from "@/lib/product-intelligence";

type Admin = SupabaseClient;

/**
 * The candidate lane menu the seeder enumerates for every advertised product. A lane's
 * `ingredientMatchers` are lowercase substrings — a product qualifies for the lane iff EVERY
 * matcher appears in at least one of its `product_ingredients.name` values (case-insensitive).
 *
 * The rows carry the raw parts a headline needs (enemy · mechanism · desiredOutcome · proofKind ·
 * evidenceTier). `searchDemand` comes from `fetchSearchDemand` at seed time, not the table.
 *
 * Edit this table to add / drop / rename a lane; a re-run of the seeder picks it up on the next
 * invocation without a migration.
 */
export interface SeedProblemLane {
  theme: AngleTheme;
  problem: string;
  ingredientMatchers: string[];
  benefitKey: string | null;
  enemy: string;
  mechanism: string;
  desiredOutcome: string;
  proofKind: string;
  evidenceTier: EvidenceTier;
}

export const PROBLEM_LANES: readonly SeedProblemLane[] = [
  // ── 🪞 BEAUTY ──────────────────────────────────────────────────────────────
  {
    theme: "beauty",
    problem: "wrinkles and aging skin",
    ingredientMatchers: ["collagen"],
    benefitKey: "Skin Health & Hydration",
    enemy: "serums that only sit on top",
    mechanism: "collagen rebuilds skin from within",
    desiredOutcome: "younger, smoother skin",
    proofKind: "clinical_stat",
    evidenceTier: "science_strong",
  },
  {
    theme: "beauty",
    problem: "dry dull skin",
    ingredientMatchers: ["hyaluronic"],
    benefitKey: "Skin Health & Hydration",
    enemy: "topical hydrators",
    mechanism: "hyaluronic acid hydrates + plumps from the inside",
    desiredOutcome: "plump, dewy skin",
    proofKind: "clinical_stat",
    evidenceTier: "science_strong",
  },
  {
    theme: "beauty",
    problem: "thinning hair and brittle nails",
    ingredientMatchers: ["collagen"],
    benefitKey: "Skin Health & Hydration",
    enemy: "biotin gummies",
    mechanism: "collagen feeds hair follicles + nail beds",
    desiredOutcome: "thicker hair, stronger nails",
    proofKind: "customer_review",
    evidenceTier: "customer_only",
  },
  // ── ⏳ LONGEVITY ───────────────────────────────────────────────────────────
  {
    theme: "longevity",
    problem: "joint pain and stiff knees",
    ingredientMatchers: ["collagen"],
    benefitKey: "Joint Health & Mobility",
    enemy: "another glucosamine pill",
    mechanism: "collagen cushions and rebuilds the joint",
    desiredOutcome: "move without the stiffness",
    proofKind: "clinical_stat",
    evidenceTier: "science_strong",
  },
  {
    theme: "longevity",
    problem: "losing muscle and strength after 40",
    ingredientMatchers: ["collagen"],
    benefitKey: "Muscle Mass & Recovery",
    enemy: "just more protein powder",
    mechanism: "collagen preserves lean mass + strengthens tendons",
    desiredOutcome: "keep your strength as you age",
    proofKind: "clinical_stat",
    evidenceTier: "science_modest",
  },
  {
    theme: "longevity",
    problem: "weak aging bones",
    ingredientMatchers: ["collagen"],
    benefitKey: "Bone Health & Density",
    enemy: "calcium alone",
    mechanism: "collagen slows the bone breakdown that thins your bones",
    desiredOutcome: "denser, stronger bones",
    proofKind: "clinical_stat",
    evidenceTier: "science_modest",
  },
  {
    theme: "longevity",
    problem: "chronic stress that ages you",
    ingredientMatchers: ["ashwagandha"],
    benefitKey: "Stress & Cortisol",
    enemy: "another stress relief supplement",
    mechanism: "ashwagandha lowers cortisol at the source",
    desiredOutcome: "calm nervous system, resilient body",
    proofKind: "clinical_stat",
    evidenceTier: "science_strong",
  },
  // ── ⚖️ HEALTHY WEIGHT ──────────────────────────────────────────────────────
  {
    theme: "healthy_weight",
    problem: "stubborn belly fat",
    ingredientMatchers: ["mct"],
    benefitKey: "Weight Management & Fat Loss",
    enemy: "another diet",
    mechanism: "MCT burns fat instead of storing it",
    desiredOutcome: "lose the belly, keep the muscle",
    proofKind: "clinical_stat",
    evidenceTier: "science_modest",
  },
  {
    theme: "healthy_weight",
    problem: "constant cravings and always hungry",
    ingredientMatchers: ["mct"],
    benefitKey: "Weight Management & Fat Loss",
    enemy: "willpower and snacking",
    mechanism: "MCT triggers fullness hormones",
    desiredOutcome: "the cravings just stop",
    proofKind: "customer_review",
    evidenceTier: "science_modest",
  },
  {
    theme: "healthy_weight",
    problem: "cortisol belly from stress",
    ingredientMatchers: ["ashwagandha"],
    benefitKey: "Weight Management & Fat Loss",
    enemy: "another diet plan",
    mechanism: "ashwagandha lowers the cortisol that stores belly fat",
    desiredOutcome: "lose the stress-driven belly",
    proofKind: "clinical_stat",
    evidenceTier: "science_modest",
  },
  {
    theme: "healthy_weight",
    problem: "blood sugar spikes and crashes",
    ingredientMatchers: ["collagen"],
    benefitKey: "Weight Management & Fat Loss",
    enemy: "cutting out all carbs",
    mechanism: "the glycine in collagen slows how fast sugar hits your blood",
    desiredOutcome: "steady energy, no sugar crash",
    proofKind: "mechanism",
    evidenceTier: "science_modest",
  },
  // ── ⚡ ENERGY & PERFORMANCE ─────────────────────────────────────────────────
  {
    theme: "energy_performance",
    problem: "energy that crashes by 2pm",
    ingredientMatchers: ["mct"],
    benefitKey: "Energy & Athletic Performance",
    enemy: "more coffee and energy drinks",
    mechanism: "MCT converts to clean ketone energy with no sugar spike",
    desiredOutcome: "energy that doesn't crash",
    proofKind: "mechanism",
    evidenceTier: "science_strong",
  },
  {
    theme: "energy_performance",
    problem: "morning fatigue",
    ingredientMatchers: ["coffee"],
    benefitKey: "Energy & Athletic Performance",
    enemy: "the bitter coffee-shop line",
    mechanism: "coffee delivers a clean caffeine kick without the jitter blend",
    desiredOutcome: "wake up and go",
    proofKind: "customer_review",
    evidenceTier: "customer_only",
  },
  {
    theme: "energy_performance",
    problem: "hitting the wall in your workout",
    ingredientMatchers: ["creatine"],
    benefitKey: "Energy & Athletic Performance",
    enemy: "another pre-workout",
    mechanism: "creatine rebuilds ATP so your muscles fire longer",
    desiredOutcome: "train harder, recover faster",
    proofKind: "clinical_stat",
    evidenceTier: "science_strong",
  },
  {
    theme: "energy_performance",
    problem: "losing strength after 40",
    ingredientMatchers: ["creatine"],
    benefitKey: "Muscle Mass & Recovery",
    enemy: "accepting the age-related decline",
    mechanism: "creatine preserves lean mass + strength",
    desiredOutcome: "stay strong for another decade",
    proofKind: "clinical_stat",
    evidenceTier: "science_strong",
  },
  {
    theme: "energy_performance",
    problem: "post-workout soreness slows you down",
    ingredientMatchers: ["mct"],
    benefitKey: "Energy & Athletic Performance",
    enemy: "sugary post-workout drinks",
    mechanism: "MCT fuels the workout with fat instead of sugar",
    desiredOutcome: "recover faster between sessions",
    proofKind: "clinical_stat",
    evidenceTier: "science_modest",
  },
  // ── 🧠 FOCUS ────────────────────────────────────────────────────────────────
  {
    theme: "focus",
    problem: "brain fog and the afternoon slump",
    ingredientMatchers: ["mct"],
    benefitKey: "Mental Clarity & Focus",
    enemy: "another cup of coffee",
    mechanism: "MCT ketones fuel the brain within the half hour",
    desiredOutcome: "a clear head by the second sip",
    proofKind: "customer_review",
    evidenceTier: "science_modest",
  },
  {
    theme: "focus",
    problem: "brain fog from anxiety",
    ingredientMatchers: ["ashwagandha"],
    benefitKey: "Mental Clarity & Focus",
    enemy: "another anxiety hack",
    mechanism: "ashwagandha calms the anxiety that clouds thinking",
    desiredOutcome: "sharp, calm focus",
    proofKind: "clinical_stat",
    evidenceTier: "science_strong",
  },
  {
    theme: "focus",
    problem: "cannot focus in the morning",
    ingredientMatchers: ["coffee"],
    benefitKey: "Mental Clarity & Focus",
    enemy: "a second latte",
    mechanism: "clean caffeine kicks focus in without the crash",
    desiredOutcome: "focused, calm mornings",
    proofKind: "customer_review",
    evidenceTier: "customer_only",
  },
  // ── 🦠 GUT ──────────────────────────────────────────────────────────────────
  {
    theme: "gut",
    problem: "bloating and leaky gut",
    ingredientMatchers: ["collagen"],
    benefitKey: "Digestive Health",
    enemy: "another probiotic",
    mechanism: "collagen repairs the gut lining",
    desiredOutcome: "the bloat is gone",
    proofKind: "clinical_stat",
    evidenceTier: "science_modest",
  },
  {
    theme: "gut",
    problem: "digestive discomfort",
    ingredientMatchers: ["mct"],
    benefitKey: "Digestive Health",
    enemy: "an elimination diet",
    mechanism: "MCT balances the gut microbiome",
    desiredOutcome: "quiet, comfortable gut",
    proofKind: "mechanism",
    evidenceTier: "science_modest",
  },
  // ── 🌱 SUPERFOOD BLENDS ────────────────────────────────────────────────────
  {
    theme: "gut",
    problem: "not enough greens in your diet",
    ingredientMatchers: ["spirulina"],
    benefitKey: "Digestive Health",
    enemy: "choking down a bag of kale",
    mechanism: "concentrated greens deliver the micronutrient load in one scoop",
    desiredOutcome: "the greens box, checked",
    proofKind: "mechanism",
    evidenceTier: "science_modest",
  },
  {
    theme: "energy_performance",
    problem: "sluggish afternoon energy",
    ingredientMatchers: ["chlorella"],
    benefitKey: "Energy & Athletic Performance",
    enemy: "sugary energy drinks",
    mechanism: "chlorella delivers dense micronutrient energy",
    desiredOutcome: "steady all-day energy",
    proofKind: "customer_review",
    evidenceTier: "customer_only",
  },
] as const;

export interface SeedProductAnglePaletteInput {
  admin: Admin;
  workspaceId: string;
  productId: string;
  /**
   * Test seam — bypass `getProductIntelligence` and use these ingredient names directly. In prod
   * this stays undefined so the seeder sources ingredients via the product-intelligence SDK.
   */
  ingredientNames?: string[];
  /**
   * Test seam — bypass `isAdvertisedProduct` and pretend the product is advertised. Never set
   * this in prod code; the seeder's whole point is the advertised-products gate.
   */
  skipAdvertisedGate?: boolean;
}

export interface SeededAngle {
  angleId: string;
  theme: AngleTheme;
  problem: string;
  ingredientMatched: string;
  searchDemand: string;
  demandSource: string;
  promoted: false;
}

export interface SeedProductAnglePaletteSummary {
  productId: string;
  advertised: true;
  ingredientNames: string[];
  lanesConsidered: number;
  lanesMatched: number;
  rowsUpserted: number;
  seeded: SeededAngle[];
  provider: string;
}

/**
 * The core seeder. Given a product id, drafts an angle-palette row per matching PROBLEM_LANES
 * lane with `isActive=false` + `source='seeded'` + `searchDemand` scored via the demand sweep.
 *
 * Refuses to seed a non-advertised product — hero-product gate is the source of truth for what
 * can enter the ad pipeline (docs/brain/libraries/advertised-products.md).
 *
 * Never touches `product_angle_palette` via raw `.from(...)` — every mutation flows through
 * `upsertAngle` in the angle-palette SDK.
 */
export async function seedProductAnglePalette(
  input: SeedProductAnglePaletteInput,
): Promise<SeedProductAnglePaletteSummary> {
  const { admin, workspaceId, productId } = input;
  const runIso = new Date().toISOString();

  if (!input.skipAdvertisedGate) {
    const advertised = await isAdvertisedProduct(admin, productId);
    if (!advertised) {
      throw new Error(
        `seed-angle-palette: product ${productId} is not is_advertised=true — the advertised-products chokepoint refuses to seed a non-hero product. Flip products.is_advertised or pass a hero id.`,
      );
    }
  }

  const ingredientNames = input.ingredientNames
    ?? await loadIngredientNames(admin, workspaceId, productId);
  const lowered = ingredientNames.map((n) => n.toLowerCase());

  const seeded: SeededAngle[] = [];
  const providers = new Set<string>();
  let lanesMatched = 0;

  for (const lane of PROBLEM_LANES) {
    const matched = matchLane(lane, lowered);
    if (!matched) continue;
    lanesMatched++;

    const demand = await fetchSearchDemand({
      admin,
      workspaceId,
      ingredient: matched.matcher,
      problem: lane.problem,
    });
    providers.add(demand.source);

    const notes = buildProvenance({ runIso, ingredient: matched.matcher, demand });

    const angleId = await upsertAngle(admin, workspaceId, productId, {
      theme: lane.theme,
      problem: lane.problem,
      ingredients: matched.productIngredients,
      benefitKey: lane.benefitKey,
      enemy: lane.enemy,
      mechanism: lane.mechanism,
      desiredOutcome: lane.desiredOutcome,
      proofKind: lane.proofKind,
      evidenceTier: lane.evidenceTier,
      searchDemand: demand.tier,
      source: "seeded",
      isActive: false,
      notes,
    });

    seeded.push({
      angleId,
      theme: lane.theme,
      problem: lane.problem,
      ingredientMatched: matched.matcher,
      searchDemand: demand.tier,
      demandSource: demand.source,
      promoted: false,
    });
  }

  const provider = providers.size === 0
    ? "none"
    : providers.size === 1
      ? [...providers][0]!
      : [...providers].sort().join("+");

  return {
    productId,
    advertised: true,
    ingredientNames,
    lanesConsidered: PROBLEM_LANES.length,
    lanesMatched,
    rowsUpserted: seeded.length,
    seeded,
    provider,
  };
}

interface LaneMatch {
  matcher: string;
  productIngredients: string[];
}

function matchLane(lane: SeedProblemLane, loweredProductIngredients: string[]): LaneMatch | null {
  const productIngredientsMatched: string[] = [];
  for (const matcher of lane.ingredientMatchers) {
    const hit = loweredProductIngredients.find((n) => n.includes(matcher));
    if (!hit) return null;
    if (!productIngredientsMatched.includes(hit)) productIngredientsMatched.push(hit);
  }
  return {
    matcher: lane.ingredientMatchers[0]!,
    productIngredients: productIngredientsMatched,
  };
}

async function loadIngredientNames(
  admin: Admin,
  workspaceId: string,
  productId: string,
): Promise<string[]> {
  const pi = await getProductIntelligence(admin, workspaceId, productId);
  return pi.ingredients
    .map((r) => String((r as { name?: unknown }).name ?? "").trim())
    .filter((n) => n.length > 0);
}

function buildProvenance(args: {
  runIso: string;
  ingredient: string;
  demand: Pick<SearchDemandRecord, "tier" | "rawVolume" | "source">;
}): string {
  const vol = args.demand.rawVolume === null ? "unknown" : String(args.demand.rawVolume);
  return `seed-angle-palette @ ${args.runIso}: ingredient=${args.ingredient} tier=${args.demand.tier} volume=${vol} source=${args.demand.source}`;
}

/** Format a summary as a plain-text table an operator scans before promoting anything. */
export function formatSeededTable(summary: SeedProductAnglePaletteSummary): string {
  if (summary.seeded.length === 0) {
    return `(no lanes matched — product ingredients did not satisfy any PROBLEM_LANES row)`;
  }
  const header = ["theme", "problem", "searchDemand", "source", "promoted"];
  const rows = summary.seeded.map((a) => [
    a.theme,
    a.problem,
    a.searchDemand,
    a.demandSource,
    String(a.promoted),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(header), line(widths.map((w) => "".padEnd(w, "-"))), ...rows.map(line)].join("\n");
}

// The full `ProductAngle` shape isn't returned by the seeder (we return the smaller SeededAngle
// summary), but consumers occasionally want the underlying angle-palette type — re-export so a
// caller can import both from one place.
export type { ProductAngle };
