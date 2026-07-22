/**
 * factor-rollup-policies — resolver for the workspace-tunable significance
 * thresholds behind the [[./factor-rollup-sdk|factor-rollup SDK]]. The SDK
 * rolls up per-{theme, angle, pattern, combination} CPA/CTR/ROAS and stamps
 * every row with a significance verdict; this resolver returns the tuned
 * thresholds the verdict is computed against.
 *
 * Modeled on [[./testing-results-sdk.ts]] `resolveTestThresholds` (line 58):
 * ONE row per workspace in [[../../../supabase/migrations/20261125120000_factor_rollup_policies.sql|factor_rollup_policies]],
 * every threshold nullable so an unset knob falls through to the code-owned
 * default here. The gate axes track the goal's naming (spend + purchases +
 * confidence, per docs/brain/specs/factor-rollup-sdk-with-significance-gate.md).
 *
 * Read-only chokepoint — the shipped [[../../../scripts/_check-factor-rollup-sdk-compliance.ts]]
 * predeploy check forbids raw `.from("factor_rollup_policies")` calls anywhere
 * outside this file.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The three tuning knobs the significance gate reads. Confidence is reserved
 *  for the follow-on statistical-gate work — the shipped gate is spend + purchases. */
export interface FactorRollupThresholds {
  /** Minimum window spend (cents) a factor bucket must hit before it can pass the gate. */
  minSpendCents: number;
  /** Minimum purchases in the window before a factor bucket can pass the gate. */
  minPurchases: number;
  /** Reserved confidence axis (0..1); unused by the shipped verdict but returned verbatim. */
  confidence: number;
}

/** Code-owned defaults. A workspace with no `factor_rollup_policies` row gets these
 *  as-is. Numbers match the spec's Phase-1 description: $200 spend / 5 purchases /
 *  0.8 confidence — enough traffic that a bucket's CPA/CTR/ROAS is not two-purchase
 *  noise, without being so high that a mid-scale workspace can never pass the gate. */
export const DEFAULT_FACTOR_ROLLUP_THRESHOLDS: FactorRollupThresholds = {
  minSpendCents: 20000, // $200
  minPurchases: 5,
  confidence: 0.8,
};

/** Read the workspace's tuned thresholds, falling back to code defaults per axis. */
export async function resolveFactorRollupThresholds(
  admin: Admin,
  workspaceId: string,
): Promise<FactorRollupThresholds> {
  const { data } = await admin
    .from("factor_rollup_policies")
    .select("min_spend_cents, min_purchases, confidence")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const p = (data ?? {}) as Record<string, number | null>;
  const n = (v: number | null | undefined, d: number) => (v == null ? d : Number(v));
  return {
    minSpendCents: n(p.min_spend_cents, DEFAULT_FACTOR_ROLLUP_THRESHOLDS.minSpendCents),
    minPurchases: n(p.min_purchases, DEFAULT_FACTOR_ROLLUP_THRESHOLDS.minPurchases),
    confidence: n(p.confidence, DEFAULT_FACTOR_ROLLUP_THRESHOLDS.confidence),
  };
}
