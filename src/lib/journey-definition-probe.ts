/**
 * Journey-definition activity probe (Phase 3 of review-request-sol-session).
 *
 * The spec's Phase-3 verification pins:
 *
 *   > **Reachability, not just compilation.** review-collection-foundations
 *   > Phase 3 shipped this journey's HANDLER while its `journey_definitions`
 *   > row was never created — the phase's checks were code-existence greps,
 *   > all true, none of them the thing that mattered, so it read `shipped`
 *   > while the journey was unreachable. This phase carries a
 *   > `journey_definition_active_by_slug` DB probe so 'delivery works' is
 *   > asserted against the database rather than the filesystem.
 *
 * This module is that probe. `assertJourneyDefinitionActive(admin,
 * workspaceId, slug)` returns true only when the workspace has an
 * `is_active=true` row for the exact slug. Phase-3 delivery calls
 * `assertProductReviewJourneyActive` before shipping any ask — a null /
 * inactive row is a hard SKIP, so a workspace whose seed migration
 * silently missed doesn't burn goodwill on a link that resolves to a 404.
 *
 * Split into a low-level slug-based probe and a domain-shortcut for the
 * product-review journey so callers can't fat-finger the slug.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The exact slug the seed migration uses for the product-review journey. */
export const PRODUCT_REVIEW_JOURNEY_SLUG = "product-review";

/**
 * Probe — does an ACTIVE journey_definitions row exist for
 * (workspace_id, slug)? Returns a small typed result so a caller can
 * distinguish a missing row from an inactive one (both are hard SKIPs,
 * but the log line differs).
 */
export type JourneyDefinitionProbeResult =
  | { active: true; journeyId: string }
  | { active: false; reason: "not_found" | "inactive" };

/** Slug-based probe. Kept exported so a future journey can reuse it. */
export async function assertJourneyDefinitionActive(
  admin: SupabaseClient,
  workspaceId: string,
  slug: string,
): Promise<JourneyDefinitionProbeResult> {
  if (!workspaceId) return { active: false, reason: "not_found" };
  if (!slug) return { active: false, reason: "not_found" };
  const { data, error } = await admin
    .from("journey_definitions")
    .select("id, is_active")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { active: false, reason: "not_found" };
  if (!data.is_active) return { active: false, reason: "inactive" };
  return { active: true, journeyId: data.id as string };
}

/**
 * Domain shortcut for the product-review journey. The delivery path calls
 * THIS one so the pinned slug is never fat-fingered at a call site.
 */
export function assertProductReviewJourneyActive(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<JourneyDefinitionProbeResult> {
  return assertJourneyDefinitionActive(
    admin,
    workspaceId,
    PRODUCT_REVIEW_JOURNEY_SLUG,
  );
}
