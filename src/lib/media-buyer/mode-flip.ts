/**
 * media-buyer/mode-flip — the shared iteration_policies mode-flip mutation.
 *
 * Extracted so BOTH the owner arm/disarm route ([[../../app/api/growth/media-buyer/arm/route]])
 * AND the self-correcting revert ([[./self-correcting]]) drive the same COMPARE-AND-SET
 * flip: UPDATE iteration_policies SET mode WHERE workspace_id AND status='active' AND
 * campaign_id IS NULL (the v1 workspace-scope rows — matches iteration-policy-authoring.ts),
 * returning the transitioned row ids. Callers layer their own audit — this helper is
 * purely the mutation.
 *
 * Never throws: a raced flip (0 rows transitioned) resolves as `{ ok: true, updatedIds: [] }`
 * so an audit call can distinguish "flipped nothing" from "database errored".
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type MediaBuyerPolicyMode = "armed" | "shadow";

export interface FlipMediaBuyerPolicyModeResult {
  ok: boolean;
  updatedIds: string[];
  error?: string;
}

/**
 * Flip the workspace's active v1 iteration policy to `targetMode`. Returns the ids of the
 * rows that transitioned. See file header for the compare-and-set scope.
 */
export async function flipMediaBuyerPolicyMode(
  admin: Admin,
  workspaceId: string,
  targetMode: MediaBuyerPolicyMode,
): Promise<FlipMediaBuyerPolicyModeResult> {
  const { data, error } = await admin
    .from("iteration_policies")
    .update({ mode: targetMode })
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("campaign_id", null)
    .select("id");
  if (error) return { ok: false, updatedIds: [], error: error.message };
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  return { ok: true, updatedIds: ids };
}
