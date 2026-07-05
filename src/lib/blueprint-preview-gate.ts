/**
 * Two small predicates the storefront blueprint-lander route calls to gate
 * visibility — Phase 2 of the "build the {slug} lander" spec chain
 * (see e.g. docs/brain/specs/lander-build-advertorial-listicle-amazing-coffee-23e0ea01.md).
 *
 *   • `isWorkspaceOwner` — true when the current auth session belongs to a
 *     [[workspace_members]] row with `role='owner'` for the target workspace.
 *     Used by the `?preview=1` gate on a blueprint lander: only the owner may
 *     view the not-yet-public lander before it's promoted.
 *
 *   • `isBlueprintLanderPubliclyServed` — true when a [[storefront_experiments]]
 *     row exists for `(workspace_id, product_id, lander_type)` with a status
 *     that ACTUALLY SERVES traffic (`running` or `promoted`). Public access is
 *     the OPPOSITE of preview: no preview flag AND the storefront row is
 *     serving → non-owners see the lander; else they're 403'd.
 *
 * Both are pure reads. The single write (Phase 2 wiring — insert the baseline
 * storefront_experiments row for a blueprint) lives in
 * [[blueprint-experiment-wiring]].
 */
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StorefrontLanderType } from "@/lib/cleo-blueprint";

/**
 * Owner check for the current auth session against a specific workspace.
 * Read-only. Two-hop: (1) resolve the session's user id via the ssr client,
 * (2) look up the [[workspace_members]] row for that (workspace_id, user_id)
 * via the service-role admin client so RLS doesn't quietly hide the row.
 *
 * Returns false — never throws — on any of: no session, session but not a
 * member of THIS workspace, member but role ≠ 'owner'. The caller either
 * renders the lander (owner=true) or 403s (owner=false).
 */
export async function isWorkspaceOwner(workspaceId: string): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const admin = createAdminClient();
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    return member?.role === "owner";
  } catch {
    return false;
  }
}

/**
 * True when the blueprint lander's paired [[storefront_experiments]] row is
 * SERVING traffic (`status IN ('running','promoted')`) — the invariant the
 * spec's Phase 2 verification captures ("a non-owner is 403'd until the row
 * is promoted"). `draft` / `killed` / `rolled_back` all count as NOT serving
 * and 403 the non-owner.
 *
 * The row is keyed by `(workspace_id, product_id, lander_type)` — the same
 * shape the storefront optimizer's `existingLanderTypesForProduct` reads.
 * Returns false when the table is missing (pre-migration) — the render is
 * still owner-only in that case.
 */
export async function isBlueprintLanderPubliclyServed(
  workspaceId: string,
  productId: string,
  landerType: StorefrontLanderType,
): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("storefront_experiments")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .eq("lander_type", landerType)
      .in("status", ["running", "promoted"])
      .limit(1)
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}
