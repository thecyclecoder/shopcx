/**
 * Storefront Optimizer — activation + product-scope gate (Phase 1 of
 * docs/brain/specs/storefront-optimizer-activation-gate.md).
 *
 * This is the control surface the Storefront Optimizer agent (M4) reads BEFORE it
 * proposes anything. It is the storefront analogue of the ad engine's
 * `loadActivePolicy` ([[meta__decision-engine]]) over `iteration_policies`: the
 * engine reads it READ-ONLY and never writes its own policy. The governance rule:
 *
 *   • No policy / `active=false` → the agent does NOT even propose (fully idle).
 *     Safe-by-default for any workspace; the optimizer is dark until an owner flips
 *     it on (mirrors "no active policy ⇒ zero autonomous actions").
 *   • `active=true` → the agent proposes campaigns, each surfaced as a
 *     `needs_approval` Build/Approve card. The owner's tap is what runs a test —
 *     nothing touches live traffic without it (propose-and-approve mode).
 *   • `auto_run_reversible=true` (a later Growth-director opt-in; default false)
 *     lets REVERSIBLE levers (copy/hero/chapter) skip the per-campaign tap. Offer /
 *     structural levers stay approval-gated REGARDLESS of this flag.
 *   • `product_scope` is an ENFORCED allowlist — a proposal for an out-of-scope
 *     product is REFUSED here, not just left unscheduled.
 *
 * The agent NEVER writes this table — only the Growth director / a human does (via
 * the dashboard control surface). This file is read-only over the policy.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The typed policy contract M4 reads. One row per workspace. */
export interface OptimizerPolicy {
  id: string;
  workspace_id: string;
  /** "the agent proposes campaigns at all." Default OFF. */
  active: boolean;
  /** Enforced allowlist of product ids the optimizer may touch (→ products.id). */
  product_scope: string[];
  /** Later opt-in (default false): reversible levers may auto-run without the tap. */
  auto_run_reversible: boolean;
  // editable guardrails — the bounded proxy the engine optimizes within
  max_concurrent_experiments: number;
  min_sample: number;
  holdout_pct: number;
  auto_rollback_ltv_tolerance: number;
  auto_rollback_windows: number;
  auto_rollback_refund_spike_delta: number;
  /** The persist-to-renewal-offer margin floor (storefront-renewal-offer-lever P2). An offer
   *  whose MODELED renewal margin (after the offer's delta) falls below this is REFUSED at
   *  propose time and escalated to Growth + CFO via director_activity — it never reaches a
   *  normal Build/Approve card. Fraction in [0,1]; column default 0.40 (40%). When the product's
   *  COGS source is missing, the floor SOFT-passes (cogs_source_missing=true on the offer row);
   *  the audit trail records that the floor wasn't verifiable, not that it was met. */
  min_renewal_margin_pct: number;
  created_by: "agent" | "human";
  rationale: string | null;
}

/** Floor returned by loadOptimizerPolicy when the column doesn't exist yet (pre-migration) — keeps
 *  the offer-lever code defensive against a partial deploy by treating "no floor known" as the
 *  default. Mirrors the migration default. */
export const DEFAULT_MIN_RENEWAL_MARGIN_PCT = 0.4;

/**
 * The lever class a proposed campaign tests. Drives whether it can ever auto-run:
 *   • reversible — copy / hero / chapter content patch (the only auto-run-eligible class)
 *   • offer      — pricing / discount / renewal-offer change (M6; ALWAYS approval-gated)
 *   • structural — a structural rewrite / new component (ALWAYS approval-gated)
 */
export type LeverClass = "reversible" | "offer" | "structural";

/** What the gate decided for a proposed campaign. */
export type GateDisposition =
  | "idle" // policy off / absent — the agent doesn't propose at all
  | "refused_scope" // product not in product_scope — refused, not just unscheduled
  | "needs_approval" // propose as a Build/Approve card; the owner's tap runs it
  | "auto_run"; // reversible lever + auto_run_reversible — may run without the tap

export interface ProposalGate {
  /** True only when the agent may propose this campaign (active + in scope). */
  canPropose: boolean;
  /** Whether the product is inside the enforced scope allowlist. */
  inScope: boolean;
  disposition: GateDisposition;
  /** Human/agent-legible reason — surfaced in the agent's reasoning + the card. */
  reason: string;
}

/**
 * Load a workspace's optimizer policy. Returns null when there is no row (the agent
 * then treats the optimizer as OFF — zero proposals). Best-effort: returns null if
 * the table doesn't exist yet (pre-migration), degrading gracefully like
 * [[storefront-experiments]] `loadActiveExperiments`.
 */
export async function loadOptimizerPolicy(
  admin: Admin,
  workspaceId: string,
): Promise<OptimizerPolicy | null> {
  try {
    const { data } = await admin
      .from("storefront_optimizer_policy")
      .select(
        "id, workspace_id, active, product_scope, auto_run_reversible, max_concurrent_experiments, min_sample, holdout_pct, auto_rollback_ltv_tolerance, auto_rollback_windows, auto_rollback_refund_spike_delta, min_renewal_margin_pct, created_by, rationale",
      )
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!data) return null;
    const row = data as Partial<OptimizerPolicy> & { min_renewal_margin_pct?: number | null };
    // Pre-migration: the column may be absent; coerce to the default so the offer-lever code
    // always sees a finite floor (the live column has a NOT NULL default once the migration lands).
    return {
      ...(row as OptimizerPolicy),
      min_renewal_margin_pct:
        typeof row.min_renewal_margin_pct === "number" ? row.min_renewal_margin_pct : DEFAULT_MIN_RENEWAL_MARGIN_PCT,
    };
  } catch {
    return null; // table not present yet — degrade to OFF
  }
}

/** True when the optimizer is switched on for this workspace (policy present + active). */
export function isOptimizerActive(policy: OptimizerPolicy | null): boolean {
  return policy?.active === true;
}

/** Whether a product is inside the enforced scope allowlist. */
export function isProductInScope(policy: OptimizerPolicy | null, productId: string): boolean {
  return !!policy && policy.product_scope.includes(productId);
}

/**
 * The single gate the optimizer agent calls before proposing a campaign on a
 * `(product × lander × audience)`. Encodes the full propose-and-approve contract:
 *
 *   active=false / no policy        → idle           (don't propose)
 *   active, product NOT in scope     → refused_scope  (refused, not just unscheduled)
 *   active, in scope, offer/structural → needs_approval (always gated)
 *   active, in scope, reversible, auto_run_reversible=false → needs_approval
 *   active, in scope, reversible, auto_run_reversible=true  → auto_run
 *
 * `canPropose` is false for idle/refused_scope — there is NO path to live traffic
 * without either the owner's Build/Approve tap (needs_approval) or an explicit
 * reversible-lever auto-run opt-in.
 */
export function evaluateProposalGate(
  policy: OptimizerPolicy | null,
  opts: { productId: string; leverClass: LeverClass },
): ProposalGate {
  if (!isOptimizerActive(policy)) {
    return {
      canPropose: false,
      inScope: false,
      disposition: "idle",
      reason: "Optimizer is OFF for this workspace (no active policy) — not proposing.",
    };
  }
  const inScope = isProductInScope(policy, opts.productId);
  if (!inScope) {
    return {
      canPropose: false,
      inScope: false,
      disposition: "refused_scope",
      reason: `Product ${opts.productId} is not in the optimizer product_scope — proposal refused.`,
    };
  }
  // In scope + active. Only reversible levers with the explicit opt-in may auto-run;
  // offers + structural rewrites are ALWAYS approval-gated (they bleed margin / are
  // higher-stakes), regardless of auto_run_reversible.
  if (opts.leverClass === "reversible" && policy!.auto_run_reversible) {
    return {
      canPropose: true,
      inScope: true,
      disposition: "auto_run",
      reason: "Reversible lever and auto_run_reversible is on — may run without the per-campaign tap.",
    };
  }
  return {
    canPropose: true,
    inScope: true,
    disposition: "needs_approval",
    reason:
      opts.leverClass === "reversible"
        ? "Propose as a Build/Approve card — the owner's tap runs the test (auto_run_reversible is off)."
        : `A ${opts.leverClass} lever is always approval-gated — propose as a Build/Approve card.`,
  };
}
