/**
 * storefront-optimizer-policy-authoring — the WRITE side of [[storefront_optimizer_policy]] the
 * Growth Director uses to author + activate the optimizer's bounded proxy (Phase 1 of
 * docs/brain/specs/growth-adopt-storefront-optimizer.md).
 *
 * Companion to the READ-ONLY [[storefront-optimizer-policy]] (`loadOptimizerPolicy` /
 * `evaluateProposalGate`): the agent and runtime stay read-only over the policy; only the
 * Growth director (or a human via the dashboard) writes here. The two halves of the
 * `storefront_optimizer_policy_activation` leash action:
 *
 *   1. `authorOptimizerPolicy` — upsert the workspace's single policy row at the unique
 *      `(workspace_id)` key with `active=false`. Author-only: never flips the on-switch. Carries
 *      the Director's `product_scope` allowlist, the editable guardrail thresholds, and the
 *      rationale (the legibility field the brief + audit read back).
 *   2. `activateOptimizerPolicy` — flip `active=false → true` for the workspace's row. The
 *      reversible on/off the next propose pass re-reads. Does NOT touch `auto_run_reversible`
 *      (parent spec § "Keep `auto_run_reversible=false` until M5 ships" — propose-and-approve
 *      stays the only mode until the per-lever auto-run opt-in lands).
 *
 * Both helpers are best-effort + return a typed result (no throws) — they're called from the
 * builder-worker auto-approve path where a thrown exception would leave a director_activity row
 * un-emitted. The worker calls them in sequence on auto-approve and writes one
 * `director_activity` row `action_kind='activated_optimizer_policy'` with the rationale.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The editable guardrails the agent optimizes within — the bounded proxy. Matches every
 *  guardrail column on [[storefront_optimizer_policy]]; every field is OPTIONAL so the
 *  Director can author a partial set + the column defaults fill the rest on upsert. */
export interface OptimizerPolicyThresholds {
  max_concurrent_experiments?: number;
  min_sample?: number;
  holdout_pct?: number;
  auto_rollback_ltv_tolerance?: number;
  auto_rollback_windows?: number;
  auto_rollback_refund_spike_delta?: number;
  min_renewal_margin_pct?: number;
}

export interface AuthorOptimizerPolicyInput {
  workspaceId: string;
  /** Enforced allowlist of [[products]].id strings — the only products the optimizer may touch. */
  productScope: string[];
  thresholds?: OptimizerPolicyThresholds;
  /** The Director's WHY — surfaced on the brief + the audit row. */
  rationale: string;
  /** An auth.users.id (the human/agent the Director acts on behalf of). Stamped onto `updated_by`. */
  createdBy?: string | null;
}

export interface AuthorOptimizerPolicyResult {
  ok: boolean;
  policyId?: string;
  detail: string;
}

/**
 * Upsert the workspace's single optimizer policy row at the unique `(workspace_id)` key with
 * `active=false`. Author-only — the on-switch stays OFF; `activateOptimizerPolicy` is the
 * separate flip. Carries the Director's product_scope, thresholds, rationale, and createdBy.
 *
 * Idempotent at the workspace grain — re-running with the same payload re-writes the same row
 * (the workspace's existing PK survives; `updated_at` advances). Stamps `created_by='agent'`
 * because every call comes from the Director's autonomous lane; a human-author path goes
 * through the dashboard control surface (which writes 'human').
 */
export async function authorOptimizerPolicy(
  admin: Admin,
  input: AuthorOptimizerPolicyInput,
): Promise<AuthorOptimizerPolicyResult> {
  if (!input.workspaceId) return { ok: false, detail: "authorOptimizerPolicy: workspaceId required" };
  if (!Array.isArray(input.productScope)) {
    return { ok: false, detail: "authorOptimizerPolicy: productScope must be a string[] of product ids" };
  }
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    active: false,
    product_scope: input.productScope,
    auto_run_reversible: false,
    created_by: "agent",
    updated_by: input.createdBy ?? null,
    rationale: input.rationale ?? null,
    updated_at: now,
  };
  const t = input.thresholds ?? {};
  if (typeof t.max_concurrent_experiments === "number") row.max_concurrent_experiments = t.max_concurrent_experiments;
  if (typeof t.min_sample === "number") row.min_sample = t.min_sample;
  if (typeof t.holdout_pct === "number") row.holdout_pct = t.holdout_pct;
  if (typeof t.auto_rollback_ltv_tolerance === "number") row.auto_rollback_ltv_tolerance = t.auto_rollback_ltv_tolerance;
  if (typeof t.auto_rollback_windows === "number") row.auto_rollback_windows = t.auto_rollback_windows;
  if (typeof t.auto_rollback_refund_spike_delta === "number") row.auto_rollback_refund_spike_delta = t.auto_rollback_refund_spike_delta;
  if (typeof t.min_renewal_margin_pct === "number") row.min_renewal_margin_pct = t.min_renewal_margin_pct;

  const { data, error } = await admin
    .from("storefront_optimizer_policy")
    .upsert(row, { onConflict: "workspace_id" })
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, detail: `authorOptimizerPolicy upsert failed: ${error.message}` };
  return {
    ok: true,
    policyId: (data as { id?: string } | null)?.id,
    detail: `upserted storefront_optimizer_policy for workspace ${input.workspaceId} (active=false, scope=[${input.productScope.join(",")}])`,
  };
}

export interface ActivateOptimizerPolicyInput {
  workspaceId: string;
  /** An auth.users.id (the Director / human stamping the activation onto `updated_by`). */
  activatedBy?: string | null;
}

export interface ActivateOptimizerPolicyResult {
  ok: boolean;
  /** True when this call FLIPPED the row from `active=false → true`; false when it was already on
   *  (idempotent no-op) or no row exists yet (author first). */
  flipped: boolean;
  detail: string;
}

/**
 * Flip the workspace's optimizer policy `active=false → true`. The reversible on/off the next
 * propose pass re-reads; turning the optimizer on under direct Director supervision.
 *
 * Idempotent — re-running on a row that's already `active=true` returns `{ok:true, flipped:false}`.
 * Does NOT touch `auto_run_reversible` (kept at false until M5; the per-lever auto-run opt-in
 * lands later). Fails (returns ok:false) if no policy row exists — call `authorOptimizerPolicy`
 * first.
 */
export async function activateOptimizerPolicy(
  admin: Admin,
  input: ActivateOptimizerPolicyInput,
): Promise<ActivateOptimizerPolicyResult> {
  if (!input.workspaceId) return { ok: false, flipped: false, detail: "activateOptimizerPolicy: workspaceId required" };

  const { data: existing, error: loadErr } = await admin
    .from("storefront_optimizer_policy")
    .select("id, active")
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (loadErr) return { ok: false, flipped: false, detail: `activateOptimizerPolicy load failed: ${loadErr.message}` };
  if (!existing) {
    return {
      ok: false,
      flipped: false,
      detail: `no storefront_optimizer_policy row for workspace ${input.workspaceId} — call authorOptimizerPolicy first`,
    };
  }
  if (existing.active === true) {
    return {
      ok: true,
      flipped: false,
      detail: `storefront_optimizer_policy already active for workspace ${input.workspaceId} — idempotent no-op`,
    };
  }

  const now = new Date().toISOString();
  const { error: upErr } = await admin
    .from("storefront_optimizer_policy")
    .update({ active: true, updated_by: input.activatedBy ?? null, updated_at: now })
    .eq("workspace_id", input.workspaceId);
  if (upErr) return { ok: false, flipped: false, detail: `activateOptimizerPolicy update failed: ${upErr.message}` };
  return { ok: true, flipped: true, detail: `activated storefront_optimizer_policy for workspace ${input.workspaceId}` };
}
