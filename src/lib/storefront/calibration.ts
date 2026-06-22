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
import { INITIAL_WEIGHTS_VERSION } from "@/lib/storefront/ltv-proxy";

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

export interface CalibrationState {
  /** true once M3's slow loop has reconciled at least once (calibrated_at non-null). */
  calibrated: boolean;
  /** The proxy-weights version a metric row should stamp (Phase 3 bumps it on recalibration). */
  weights_version: number;
}

/**
 * The calibration signal M3's fast loop reads when persisting a `storefront_ltv_metrics`
 * row: whether the proxy has been calibrated, and the proxy-weights version to stamp.
 * Reads the (Phase-3) `storefront_ltv_calibration` row DEFENSIVELY — before that table
 * exists the metric is honestly uncalibrated at the initial weights version (the safe,
 * conservative default; `calibrated` mirrors the inverse of `isConservative`).
 */
export async function getCalibrationState(workspaceId: string): Promise<CalibrationState> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("storefront_ltv_calibration")
      .select("calibrated_at, weights_version")
      .eq("workspace_id", workspaceId)
      .order("calibrated_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const row = data as { calibrated_at: string | null; weights_version: number | null } | null;
    return {
      calibrated: !!row?.calibrated_at,
      weights_version: row?.weights_version ?? INITIAL_WEIGHTS_VERSION,
    };
  } catch {
    return { calibrated: false, weights_version: INITIAL_WEIGHTS_VERSION };
  }
}
