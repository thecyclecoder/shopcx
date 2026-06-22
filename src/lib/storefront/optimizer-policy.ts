/**
 * Storefront Optimizer — activation + product-scope gate
 * (docs/brain/specs/storefront-optimizer-activation-gate.md).
 *
 * The read-only gate the storefront optimizer (M4) + bandit framework (M1) consult
 * before any autonomous LIVE action. Mirrors [[meta__decision-engine]] `loadActivePolicy`
 * ("no active policy → zero autonomous actions") for the ad engine — the storefront
 * equivalent of `iteration_policies`.
 *
 *   • No policy row, or `active=false` ⇒ PROPOSE-ONLY. The agent still runs the full
 *     loop (reads funnel + lever map, forms hypotheses, surfaces what it WOULD test)
 *     but stands up ZERO `running` experiments, assigns zero live variants, and writes
 *     no lander changes. It's a dry-run you can watch.
 *   • `active=true` + the product in `product_scope` ⇒ the gate is OPEN for that
 *     product: experiments may be enqueued/activated and live variants served.
 *   • Scope is ENFORCED, not narrative — a product NOT in `product_scope` is gated even
 *     when `active=true`, so the optimizer cannot touch it even if a lander exists.
 *
 * The engine NEVER writes this policy — only the Growth director / human does (the
 * dashboard control surface). Same supervisable-autonomy split as the ad engine.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The typed policy the optimizer/bandit read. Defaults mirror the M1 guardrail
 *  constants in [[experiment-refresh]] so the table is the single editable source. */
export interface StorefrontOptimizerPolicy {
  id: string;
  workspace_id: string;
  active: boolean;
  product_scope: string[]; // allowlist of product_ids the optimizer may touch
  max_concurrent_experiments: number;
  min_sample_sessions: number;
  holdout_pct: number;
  ltv_regression_tolerance: number;
  regression_windows_to_rollback: number;
  refund_spike_delta: number;
  version: number;
  created_by: "agent" | "human";
  rationale: string | null;
}

/** Default guardrails — the values a fresh OFF policy carries (and the fallback when
 *  no row exists yet). Mirror the hardcoded M1 constants in experiment-refresh.ts. */
export const DEFAULT_OPTIMIZER_GUARDRAILS = {
  max_concurrent_experiments: 3,
  min_sample_sessions: 50,
  holdout_pct: 0.1,
  ltv_regression_tolerance: 0.15,
  regression_windows_to_rollback: 2,
  refund_spike_delta: 0.1,
} as const;

/**
 * The active policy for a workspace, or null when none exists. Best-effort: returns
 * null if the table isn't present yet (pre-migration) so callers degrade gracefully —
 * and null ⇒ propose-only (the OFF-by-default invariant) via {@link optimizerGateOpen}.
 */
export async function loadStorefrontOptimizerPolicy(
  admin: Admin,
  workspaceId: string,
): Promise<StorefrontOptimizerPolicy | null> {
  try {
    const { data, error } = await admin
      .from("storefront_optimizer_policy")
      .select("*")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error || !data) return null;
    const p = data as Record<string, unknown>;
    return {
      id: p.id as string,
      workspace_id: p.workspace_id as string,
      active: !!p.active,
      product_scope: Array.isArray(p.product_scope) ? (p.product_scope as string[]) : [],
      max_concurrent_experiments: Number(p.max_concurrent_experiments ?? DEFAULT_OPTIMIZER_GUARDRAILS.max_concurrent_experiments),
      min_sample_sessions: Number(p.min_sample_sessions ?? DEFAULT_OPTIMIZER_GUARDRAILS.min_sample_sessions),
      holdout_pct: Number(p.holdout_pct ?? DEFAULT_OPTIMIZER_GUARDRAILS.holdout_pct),
      ltv_regression_tolerance: Number(p.ltv_regression_tolerance ?? DEFAULT_OPTIMIZER_GUARDRAILS.ltv_regression_tolerance),
      regression_windows_to_rollback: Number(
        p.regression_windows_to_rollback ?? DEFAULT_OPTIMIZER_GUARDRAILS.regression_windows_to_rollback,
      ),
      refund_spike_delta: Number(p.refund_spike_delta ?? DEFAULT_OPTIMIZER_GUARDRAILS.refund_spike_delta),
      version: Number(p.version ?? 1),
      created_by: p.created_by === "agent" ? "agent" : "human",
      rationale: (p.rationale as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/** Is a product within the policy's enforced scope? False for an empty/absent scope. */
export function isProductInScope(policy: StorefrontOptimizerPolicy | null, productId: string): boolean {
  return !!policy && policy.product_scope.includes(productId);
}

/**
 * The single gate every campaign-enqueue / experiment-activation / live-variant-serve
 * checks: the optimizer may take a LIVE action on `productId` only when a policy exists,
 * is `active`, AND the product is in scope. Anything else ⇒ propose-only.
 */
export function optimizerGateOpen(policy: StorefrontOptimizerPolicy | null, productId: string): boolean {
  return !!policy && policy.active && isProductInScope(policy, productId);
}
