/**
 * Research recipe registry + runner.
 *
 * Each recipe lives under src/lib/research/recipes/<slug>.ts and gets
 * registered below. Recipes are TypeScript (not config) — see
 * docs/brain/lifecycles/research-and-heal.md for the design rationale.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { verifyCouponPromises } from "@/lib/research/recipes/verify-coupon-promises";
import { verifySubscriptionChanges } from "@/lib/research/recipes/verify-subscription-changes";
import { verifyGrandfatheredPricing } from "@/lib/research/recipes/verify-grandfathered-pricing";
import type { ResearchRecipe, ResearchResult } from "@/lib/research/types";

export const RECIPE_REGISTRY: Record<string, ResearchRecipe> = {
  [verifyCouponPromises.slug]: verifyCouponPromises,
  [verifySubscriptionChanges.slug]: verifySubscriptionChanges,
  [verifyGrandfatheredPricing.slug]: verifyGrandfatheredPricing,
};

export function listRecipes(): ResearchRecipe[] {
  return Object.values(RECIPE_REGISTRY);
}

export function getRecipe(slug: string): ResearchRecipe | null {
  return RECIPE_REGISTRY[slug] || null;
}

/**
 * Run a recipe and persist the result to ticket_research_runs.
 * Returns the inserted row's id + the result for inline use.
 */
export async function runRecipe(
  recipeSlug: string,
  ticketId: string,
  options: {
    triggeredBy: "ai_analysis" | "manual" | "heal_reverify";
    sourceAnalysisId?: string | null;
    args?: Record<string, unknown>;
  },
): Promise<{ runId: string; result: ResearchResult; recipe: ResearchRecipe } | { error: string }> {
  const recipe = getRecipe(recipeSlug);
  if (!recipe) return { error: `Unknown recipe: ${recipeSlug}` };

  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("workspace_id")
    .eq("id", ticketId)
    .single();
  if (!ticket) return { error: "Ticket not found" };

  let result: ResearchResult;
  try {
    result = await recipe.run(ticketId, options.args);
  } catch (err) {
    return { error: `Recipe ${recipeSlug} threw: ${errText(err)}` };
  }

  const { data: inserted, error } = await admin
    .from("ticket_research_runs")
    .insert({
      workspace_id: ticket.workspace_id,
      ticket_id: ticketId,
      recipe_slug: recipe.slug,
      recipe_version: recipe.version,
      findings: result.findings,
      gaps: result.gaps,
      triggered_by: options.triggeredBy,
      source_analysis_id: options.sourceAnalysisId ?? null,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    return { error: `Failed to persist research run: ${error?.message || "unknown"}` };
  }

  return { runId: inserted.id, result, recipe };
}
