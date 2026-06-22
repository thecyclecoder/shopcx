/**
 * Conservative-mode gate — read from M3 (the storefront-ltv-proxy-reconciler).
 *
 * The bandit must "run conservatively until the slow loop calibrates once" (the
 * [[../goals/storefront-optimizer]] rule): smaller bets + tighter promote thresholds
 * until M3's ~4-month reconciler has confirmed the predicted-LTV proxy at least once.
 *
 * M3 isn't built yet, so this reads its (future) calibration signal defensively and
 * DEFAULTS TO conservative=true whenever the signal is absent — the safe direction.
 * When M3 lands it publishes a `storefront_ltv_calibration` row per workspace with a
 * non-null `calibrated_at`; flip to non-conservative once that exists.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export async function isConservative(workspaceId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("storefront_ltv_calibration")
      .select("calibrated_at")
      .eq("workspace_id", workspaceId)
      .not("calibrated_at", "is", null)
      .limit(1)
      .maybeSingle();
    return !data; // a calibrated row exists → no longer conservative
  } catch {
    return true; // M3 table absent / unreadable → stay conservative
  }
}
