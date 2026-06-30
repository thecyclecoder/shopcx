/**
 * Growth Director agent (growth-director-agent spec, Phase 1) — the SECOND live director, after Ada.
 *
 * North star (operational-rules § supervisable autonomy): CEO → Director → tool. The Growth tools
 * (iteration policies, storefront optimizer, Meta creative actions, ad-spend reallocation, ad-publish)
 * already work; nobody SUPERVISES them as a director. This module is that supervisor's Phase-1 core:
 * mirrors `platform-director` Phase 1 — the LEASH_CATEGORIES union, the per-action leash gate, and the
 * `growthIsAutoApprover` predicate. Phase 2 adds the read-only brief + investigation prompt; Phase 3
 * adds the enqueuer + applyDirectorApproval + box-worker wiring. Build-driving stays with Ada
 * permanently (CEO directive 2026-06-29) — Growth OPERATES its software, never builds.
 *
 * Activation is owner-confirmed and lands later (M6 flag flip): until `function_autonomy('growth')` is
 * `live + autonomous`, `reconcileApprovalInbox` never stamps `routed_to_function='growth'`, so the
 * enqueuer (Phase 3) is a no-op — the machinery is built but dormant.
 *
 * See docs/brain/specs/growth-director-agent.md · docs/brain/libraries/platform-director.md.
 */
import { isAutoApprover, type AutonomyMap } from "@/lib/agents/approval-router";

/** The Growth director's function slug — the DRI this director embodies. */
export const GROWTH = "growth";

// ── The leash (the spec § Phase 1) ───────────────────────────────────────────────────────────────
// What the Growth director MAY auto-approve. A structural gate (which action class) plus — enforced
// by the runner's read-only investigation in Phase 2 — a soundness gate ("never rubber-stamps").
// Anything outside this, and anything destructive/irreversible/budget-ceiling-breaking, ALWAYS
// escalates to the CEO.
export type LeashCategory =
  | "iteration_policy_activation"
  | "storefront_optimizer_policy_activation"
  | "pause_underperforming_creative"
  | "reallocate_within_ceiling"
  | "promote_ready_to_test_creative";

export const LEASH_CATEGORIES: LeashCategory[] = [
  "iteration_policy_activation",
  "storefront_optimizer_policy_activation",
  "pause_underperforming_creative",
  "reallocate_within_ceiling",
  "promote_ready_to_test_creative",
];

/**
 * The pending-action types that are UNCONDITIONALLY leash candidates → their leash category. Each must
 * still pass the read-only investigation verdict (the soundness gate added in Phase 2). The mapping is
 * 1:1 with the categories — Growth's pending-action `type` fields are named the same as the leash
 * categories themselves, so no separate adapter is needed.
 *
 * Anything not in this map — including any non-binary CHOICE action (e.g. a multi-option budget
 * reallocation choice) — falls out of leash and escalates to the CEO.
 */
const LEASH_ACTION_TYPES: Record<string, LeashCategory> = {
  iteration_policy_activation: "iteration_policy_activation",
  storefront_optimizer_policy_activation: "storefront_optimizer_policy_activation",
  pause_underperforming_creative: "pause_underperforming_creative",
  reallocate_within_ceiling: "reallocate_within_ceiling",
  promote_ready_to_test_creative: "promote_ready_to_test_creative",
};

/** A loosely-typed agent_jobs row as the worker/enqueuer reads it (Supabase returns untyped JSON). */
export interface DirectorActionLike {
  id?: string;
  type?: string;
  status?: string;
  summary?: string;
  preview?: string;
  cmd?: string;
}
export interface DirectorTargetJob {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string | null;
  status?: string;
  pending_actions: DirectorActionLike[] | null;
  log_tail?: string | null;
}

/** True iff Growth is the live + autonomous auto-approver (so requests route here). */
export function growthIsAutoApprover(autonomy: AutonomyMap): boolean {
  return isAutoApprover(GROWTH, autonomy);
}

/** One in-leash pending action the director may consider — its id + the leash class it falls into. */
export interface LeashAction {
  actionId: string;
  category: LeashCategory;
}

/** The still-pending actions on a target (default status 'pending' when absent) — what the gate decides on. */
function pendingTargetActions(job: DirectorTargetJob): DirectorActionLike[] {
  return (job.pending_actions || []).filter((a) => (a.status ?? "pending") === "pending" && a.id);
}

/**
 * The leash class for ONE pending action, or null (out of leash). Mapped via LEASH_ACTION_TYPES;
 * everything else (including unknown types and any multi-choice action) is out of leash.
 */
function categoryFor(action: DirectorActionLike): LeashCategory | null {
  const type = action.type;
  if (!type) return null;
  return LEASH_ACTION_TYPES[type] ?? null;
}

/**
 * The leash gate. Returns EVERY pending action the director may auto-approve, with its leash class,
 * plus a verdict:
 *   - `none`   — empty, OR ANY pending action is out of leash. A bundle is ALL-OR-NOTHING: one
 *                out-of-leash action escalates the whole request.
 *   - `single` — exactly one in-leash action.
 *   - `multi`  — a bundle where EVERY action is in-leash (e.g. activate an iteration policy + flip
 *                the storefront-optimizer policy as one approval). Approved atomically; the Phase-2
 *                soundness gate still confirms the bundle is reversible.
 * Mirrors `platform-director` `directorLeashCandidates`.
 */
export function directorLeashCandidates(job: DirectorTargetJob): { actions: LeashAction[]; verdict: "none" | "single" | "multi" } {
  const pending = pendingTargetActions(job);
  if (!pending.length) return { actions: [], verdict: "none" };
  const actions: LeashAction[] = [];
  for (const a of pending) {
    const category = categoryFor(a);
    if (!category) return { actions: [], verdict: "none" }; // one out-of-leash action ⇒ escalate the whole bundle
    actions.push({ actionId: a.id as string, category });
  }
  return { actions, verdict: actions.length === 1 ? "single" : "multi" };
}
