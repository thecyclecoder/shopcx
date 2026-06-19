/**
 * Box-driven product seeding orchestrator (box-product-seeding).
 *
 * Re-hosts the Product Intelligence Engine on the build box: drives ONE product
 * none → published to completion, sequentially, with no Inngest step limits and
 * no deploy-kills. Reuses the Engine verbatim (src/lib/product-intelligence/
 * engine.ts) and adds PDP ingredient extraction, triangulated benefit selection,
 * Nano Banana Pro hero imagery, a self-QA gate, and auto-publish.
 *
 * Driven by `runProductSeedJob` in scripts/builder-worker.ts (agent_jobs
 * kind='product-seed'), IN-PROCESS (the worker keeps ANTHROPIC_API_KEY + the
 * service role + the encryption key; only the spawned `claude -p` build sandbox
 * strips them). Every stage is idempotent + re-runnable.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { researchIngredientsCore, analyzeReviewsCore, generateContentCore } from "./engine";
import { seedIngredientsFromPdp } from "./extract-ingredients";
import { selectBenefits } from "./benefit-selection";
import { generateHero, type HeroResult } from "./hero-imagery";
import { publishProductContent } from "./publish";

type Admin = ReturnType<typeof createAdminClient>;
type IntelligenceStatus =
  | "none" | "ingredients_added" | "researching" | "research_complete"
  | "analyzing_reviews" | "reviews_complete" | "benefits_selected"
  | "generating_content" | "content_generated" | "published";

export interface SeedResult {
  product_id: string;
  title: string;
  final_status: IntelligenceStatus;
  published: boolean;
  steps: string[];
  reasoning: string[];
  hero?: HeroResult;
  qa?: { pass: boolean; issues: string[] };
  held_reason?: string;
}

// Per-product, stock-driven hero variant overrides (box-product-seeding §6).
// Superfood Tabs → Peach Mango (orange); never the Mixed Berry green box (OOS).
const VARIANT_OVERRIDES: Record<string, { keywords: string[]; flavor: string }> = {
  "superfood-tabs": { keywords: ["peach mango", "orange", "peach"], flavor: "peach mango" },
};

async function setStatus(admin: Admin, workspace_id: string, product_id: string, status: IntelligenceStatus) {
  await admin.from("products").update({ intelligence_status: status }).eq("id", product_id).eq("workspace_id", workspace_id);
}

/** Pick the hero variant: stock-driven override, else the primary in-stock variant. */
async function resolveHeroVariant(
  admin: Admin,
  workspace_id: string,
  product_id: string,
  handle: string | null,
): Promise<{ keywords: string[]; flavor: string | null }> {
  if (handle && VARIANT_OVERRIDES[handle]) {
    const o = VARIANT_OVERRIDES[handle];
    return { keywords: o.keywords, flavor: o.flavor };
  }
  const { data: variants } = await admin
    .from("product_variants")
    .select("title, option1, option2, available, inventory_quantity, position")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("position");
  const inStock = (variants || []).filter((v) => v.available !== false && (v.inventory_quantity == null || v.inventory_quantity > 0));
  const primary = inStock[0] || (variants || [])[0];
  if (!primary) return { keywords: [], flavor: null };
  const flavor = primary.option1 || primary.title || null;
  const keywords = [primary.option1, primary.option2, primary.title].filter(Boolean) as string[];
  return { keywords, flavor };
}

/**
 * Self-QA gate (box-product-seeding step 7). Before auto-publishing:
 *  - the hero (if generated) passed its vision check (correct variant, contained
 *    splash, right drink, no edge cutoffs) — enforced in generateHero;
 *  - every lead/supporting benefit traces to evidence (research or review IDs);
 *  - the FDA/DSHEA disclaimer is present;
 *  - "what it doesn't do" is present (publish rail).
 * Fail → hold the product at content_generated, do NOT publish.
 */
async function selfQa(
  admin: Admin,
  workspace_id: string,
  product_id: string,
  hero: HeroResult | undefined,
  contentId: string,
): Promise<{ pass: boolean; issues: string[] }> {
  const issues: string[] = [];

  if (hero && hero.status === "failed") issues.push(`hero failed QA: ${hero.reason}`);

  const { data: selections } = await admin
    .from("product_benefit_selections")
    .select("benefit_name, role, ingredient_research_ids, customer_review_ids")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .in("role", ["lead", "supporting"]);
  for (const s of selections || []) {
    const hasEvidence = ((s.ingredient_research_ids as string[] | null)?.length || 0) > 0 || ((s.customer_review_ids as string[] | null)?.length || 0) > 0;
    if (!hasEvidence) issues.push(`benefit "${s.benefit_name}" (${s.role}) has no evidence (no research/review IDs)`);
  }
  if (!selections || selections.length === 0) issues.push("no lead/supporting benefit selections");

  const { data: content } = await admin
    .from("product_page_content")
    .select("fda_disclaimer, kb_what_it_doesnt_do")
    .eq("id", contentId)
    .maybeSingle();
  if (!content?.fda_disclaimer || !content.fda_disclaimer.trim()) issues.push("FDA/DSHEA disclaimer missing");
  if (!content?.kb_what_it_doesnt_do || !content.kb_what_it_doesnt_do.trim()) issues.push("'what it doesn't do' missing");

  return { pass: issues.length === 0, issues };
}

export async function runProductSeed(args: {
  workspace_id: string;
  product_id: string;
  angle_override?: string | null;
}): Promise<SeedResult> {
  const admin = createAdminClient();
  const { workspace_id, product_id, angle_override } = args;

  const { data: product } = await admin
    .from("products")
    .select("id, title, handle, target_customer, intelligence_status")
    .eq("id", product_id)
    .eq("workspace_id", workspace_id)
    .single();
  if (!product) throw new Error("product_not_found");

  const handle: string | null = product.handle || null;
  const steps: string[] = [];
  const reasoning: string[] = [];
  const result: SeedResult = {
    product_id,
    title: product.title,
    final_status: (product.intelligence_status as IntelligenceStatus) || "none",
    published: false,
    steps,
    reasoning,
  };

  // 1. Ingredients (PDP auto-extraction).
  const ing = await seedIngredientsFromPdp(admin, { workspace_id, product_id, handle: handle || "" });
  if (ing.existing > 0) {
    steps.push(`ingredients: kept ${ing.existing} existing`);
  } else if (ing.added > 0) {
    steps.push(`ingredients: extracted ${ing.added} from PDP`);
    reasoning.push(`Pulled ${ing.added} clinically-studied ingredients from the live PDP (no manual entry).`);
  } else {
    steps.push("ingredients: none found");
    result.held_reason = "no ingredients (PDP chapter missing); add manually then re-run";
    return result;
  }
  await setStatus(admin, workspace_id, product_id, "ingredients_added");

  // 2. Ingredient research.
  await setStatus(admin, workspace_id, product_id, "researching");
  const research = await researchIngredientsCore(admin, { workspace_id, product_id });
  steps.push(`research: ${research.researched} ok${research.failed.length ? `, ${research.failed.length} failed` : ""}`);
  if (research.failed.length) reasoning.push(`Research skipped ${research.failed.length} ingredient(s) after retries: ${research.failed.join(", ")}.`);
  await setStatus(admin, workspace_id, product_id, "research_complete");

  // 3. Review analysis.
  await setStatus(admin, workspace_id, product_id, "analyzing_reviews");
  const reviews = await analyzeReviewsCore(admin, { workspace_id, product_id });
  steps.push(`reviews: analyzed ${reviews.analyzed}`);
  await setStatus(admin, workspace_id, product_id, "reviews_complete");

  // 4. Triangulated benefit selection.
  const benefits = await selectBenefits(admin, { workspace_id, product_id, handle, angle_override });
  steps.push(`benefits: ${benefits.lead} lead, ${benefits.supporting} supporting`);
  reasoning.push(`Triangulated framing + clinical evidence + review language → ${benefits.lead} lead / ${benefits.supporting} supporting benefits (each evidence-backed).`);
  if (benefits.lead === 0) {
    result.held_reason = "benefit selection produced no lead benefit";
    result.final_status = "reviews_complete";
    return result;
  }
  await setStatus(admin, workspace_id, product_id, "benefits_selected");

  // 5. Page content.
  await setStatus(admin, workspace_id, product_id, "generating_content");
  const content = await generateContentCore(admin, { workspace_id, product_id });
  steps.push(`content: generated v${content.version}`);
  await setStatus(admin, workspace_id, product_id, "content_generated");

  const { data: latestContent } = await admin
    .from("product_page_content")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const contentId = latestContent?.id as string | undefined;
  if (!contentId) {
    result.held_reason = "content row not found after generation";
    result.final_status = "content_generated";
    return result;
  }

  // 6. Nano Banana Pro hero imagery.
  const { data: ingredientRows } = await admin
    .from("product_ingredients")
    .select("name")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("display_order");
  const ingredientNames = (ingredientRows || []).map((r) => r.name);
  const variant = await resolveHeroVariant(admin, workspace_id, product_id, handle);
  const isCoffeeOrCreamer = !!handle && (handle.includes("coffee") || handle.includes("creamer"));
  const hero = await generateHero(admin, {
    workspace_id,
    product_id,
    handle,
    productTitle: product.title,
    ingredients: ingredientNames,
    flavor: variant.flavor,
    variantKeywords: variant.keywords,
    isCoffeeOrCreamer,
  });
  result.hero = hero;
  steps.push(`hero: ${hero.status}${hero.status !== "generated" ? ` (${(hero as { reason?: string }).reason || ""})` : ""}`);
  if (hero.status === "skipped") reasoning.push(`Hero gen skipped: ${hero.reason} (approved heroes are never overwritten).`);
  if (hero.status === "generated") reasoning.push(`Generated + vision-confirmed a hero for the ${variant.flavor || "primary"} variant.`);

  // 7. Self-QA gate.
  const qa = await selfQa(admin, workspace_id, product_id, hero, contentId);
  result.qa = qa;
  if (!qa.pass) {
    steps.push(`qa: HELD — ${qa.issues.join("; ")}`);
    reasoning.push(`Self-QA held publishing: ${qa.issues.join("; ")}. Product stays at content_generated for owner review.`);
    result.held_reason = qa.issues.join("; ");
    result.final_status = "content_generated";
    return result;
  }
  steps.push("qa: passed");

  // 8. Auto-publish (only on QA pass).
  const pub = await publishProductContent(admin, { workspace_id, product_id, contentId });
  if (!pub.ok) {
    steps.push(`publish: failed — ${pub.error}`);
    result.held_reason = pub.error;
    result.final_status = "content_generated";
    return result;
  }
  steps.push("published");
  reasoning.push("Self-QA passed (claims trace to evidence, disclaimer present, hero verified) → auto-published.");
  result.published = true;
  result.final_status = "published";
  return result;
}
