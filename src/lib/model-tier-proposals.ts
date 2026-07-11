/**
 * Governed model-tier change proposals (box-agent-model-tiers spec, Phase 3).
 *
 * A model tier ([[agent_model_tiers]]) changes ONLY through this flow — never a silent edit. A director
 * (or the CEO via the coaching chat) PROPOSES a change for one agent kind, citing the agent's grade
 * rollup as evidence; it routes to the agent's SUPERVISOR for approval (reuse [[approval-router]] — a
 * worker's change routes to its director, a director's own change to the CEO); on approval the
 * agent_model_tiers row updates instantly (reversible, no deploy). Every decision is logged in
 * [[approval_decisions]] (auditable, mirrors the leash).
 *
 * North star (operational-rules § supervisable autonomy): a live+autonomous director may AUTO-APPLY a
 * change within a bounded rail — the spec's rail is "a one-tier bump for a worker whose grade rollup is
 * <7" — and otherwise ESCALATES to a human seat. The auto path is logged with decided_by='director',
 * autonomous=true; the escalated path surfaces a `needs_approval` agent_jobs row that the existing
 * approval inbox decides with one tap and the box worker (`runProposedModelTierJob`) applies.
 *
 * Reuse, not reinvention: the proposal is an ordinary `needs_approval` job carrying ONE plain
 * `apply_model_tier` pending action, so the reconciler surfaces it, the inbox one-tap decides it, and
 * `approveRoadmapAction` logs it — exactly like every other gated action. The only model-tier-specific
 * bits live here (the rail + the apply effect) and in the worker runner.
 *
 * See docs/brain/specs/box-agent-model-tiers.md · docs/brain/libraries/model-tier-proposals.md.
 */
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { MODELS, type ModelTier } from "@/lib/ai-models";
import { getModelTier, applyModelTierChange } from "@/lib/agent-model-tiers";
import { MODEL_TIER_PROPOSAL_KIND, APPLY_MODEL_TIER_ACTION_TYPE, type PendingAction } from "@/lib/agent-jobs";
// control-tower-canonical-node-registry P2 — proposals resolve the TARGET agent's owner through
// the canonical node registry (single source of truth), so a director's model-tier vote and the
// approval router agree on every target kind by construction.
import { resolveNodeOwner } from "@/lib/control-tower/node-registry";
import { resolveApproverLive, loadAutonomyMap, isAutoApprover, CEO } from "@/lib/agents/approval-router";
import { recordApprovalDecision } from "@/lib/agents/approval-decisions";

type Admin = ReturnType<typeof createAdminClient>;

/** Tier order for the one-tier-step rail. The Max default (null/unset) is OUT of this order on purpose
 * — a change from/to the unset default is never "one tier", so it always needs explicit approval. */
const TIER_ORDER: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

/** The spec's auto-apply rail: a ONE-tier step between two set tiers, triggered by a sub-7 rollup. */
export function isWithinAutoApplyRail(
  currentTier: ModelTier | null,
  proposedTier: ModelTier | null,
  rollup: number | null,
): boolean {
  if (!currentTier || !proposedTier) return false; // a change from/to the Max default is never in-rail
  if (Math.abs(TIER_ORDER[proposedTier] - TIER_ORDER[currentTier]) !== 1) return false; // one tier only
  return rollup != null && rollup < 7; // a slipping grade is the trigger
}

/** The payload carried on the `apply_model_tier` pending action (read by the worker on approval). */
export interface ModelTierProposalPayload {
  proposedTier: ModelTier | null;
  currentTier: ModelTier | null;
  proposerFunction: string;
  /** the cited grade rollup (0–10), the evidence for the change. Null when none was cited. */
  rollup: number | null;
  /** free-text rationale shown in the approval preview. */
  evidence: string;
  /** the supervisor seat the proposal routed to (for the apply provenance stamp + the ledger). */
  routedTo: string;
}

export interface ProposeModelTierInput {
  targetKind: string;
  proposedTier: ModelTier | null;
  proposerFunction: string;
  rollup?: number | null;
  evidence?: string;
}

export type ProposeResult =
  | { ok: true; applied: true; tier: ModelTier | null }
  | { ok: true; applied: false; jobId?: string; routedTo: string }
  | { ok: false; error: string };

function tierLabel(t: ModelTier | null): string {
  return t ?? "Max default";
}

/**
 * Propose a model-tier change for one agent kind. Resolves the target's supervisor, then EITHER
 * auto-applies (a live+autonomous supervising director + the spec's one-tier/sub-7 rail) — logged
 * autonomous — OR surfaces a `needs_approval` proposal job routed to that supervisor for a one-tap
 * decision. Idempotent-safe: a no-op change (proposed == current) is rejected before any write.
 */
export async function proposeModelTierChange(
  admin: Admin,
  workspaceId: string,
  input: ProposeModelTierInput,
): Promise<ProposeResult> {
  const targetKind = (input.targetKind || "").trim();
  if (!targetKind) return { ok: false, error: "a target agent kind is required" };
  const proposedTier = input.proposedTier;
  if (proposedTier != null && !(proposedTier in MODELS)) return { ok: false, error: `invalid tier "${proposedTier}"` };

  const currentRow = await getModelTier(admin, workspaceId, targetKind);
  const currentTier = currentRow?.model_tier ?? null;
  if (proposedTier === currentTier) {
    return { ok: false, error: `${targetKind} is already on ${tierLabel(currentTier)} — no change` };
  }

  const proposerFunction = (input.proposerFunction || CEO).trim() || CEO;
  const rollup = input.rollup ?? null;
  const evidence = (input.evidence || "").trim();

  // The supervisor of the TARGET agent: a worker's owning function resolves UP to its live+autonomous
  // director, else the CEO; a director kind is unmapped ⇒ its own change routes to the CEO. This is the
  // single routing rule for both the auto path and the escalation, so the two never disagree.
  const routedTo = await resolveApproverLive(resolveNodeOwner(targetKind));

  // Auto-apply rail: a live+autonomous supervising director may decide its own worker's in-rail change.
  // The CEO seat never "auto-applies" here (it has no proxy above it to be supervised by) — a change
  // that lands on the CEO is an explicit human decision through the inbox.
  const autonomy = await loadAutonomyMap();
  if (routedTo !== CEO && isAutoApprover(routedTo, autonomy) && isWithinAutoApplyRail(currentTier, proposedTier, rollup)) {
    const applied = await applyModelTierChange(admin, {
      workspaceId,
      kind: targetKind,
      tier: proposedTier,
      proposedBy: proposerFunction,
      approvedBy: routedTo,
    });
    if (!applied.ok) return { ok: false, error: applied.error || "apply failed" };
    await recordApprovalDecision(admin, {
      workspaceId,
      raisedByFunction: resolveNodeOwner(targetKind) ?? CEO,
      routedToFunction: routedTo,
      decidedBy: "director",
      decision: "approved",
      reasoning: `auto-applied within rail: ${tierLabel(currentTier)} → ${tierLabel(proposedTier)}${rollup != null ? ` (rollup ${rollup}/10)` : ""}. ${evidence}`.trim(),
      autonomous: true,
    });
    return { ok: true, applied: true, tier: proposedTier };
  }

  // Escalate: surface a needs_approval proposal job the supervisor decides with one tap; the worker
  // applies it on approval. One plain action so the inbox renders an inline Approve/Decline.
  const payload: ModelTierProposalPayload = { proposedTier, currentTier, proposerFunction, rollup, evidence, routedTo };
  const action: PendingAction = {
    id: randomUUID(),
    type: APPLY_MODEL_TIER_ACTION_TYPE,
    status: "pending",
    target_kind: targetKind,
    summary: `Set ${targetKind} model → ${tierLabel(proposedTier)} (was ${tierLabel(currentTier)})${rollup != null ? ` · rollup ${rollup}/10` : ""}`,
    preview: evidence || undefined,
    payload,
  };
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: targetKind, // the target kind (the profile deep-links by kind)
      kind: MODEL_TIER_PROPOSAL_KIND,
      status: "needs_approval",
      created_by: null,
      instructions: JSON.stringify({ targetKind, proposedTier, currentTier, proposerFunction, rollup, evidence, routedTo }),
      pending_actions: [action],
    })
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, applied: false, jobId: (data as { id?: string } | null)?.id, routedTo };
}

/**
 * Apply an APPROVED `apply_model_tier` action — the worker's effect on resume. Reads the proposed tier
 * + provenance off the action payload and upserts the registry row. Pure effect; the approve path
 * already logged the decision to [[approval_decisions]].
 */
export async function applyApprovedModelTierProposal(
  admin: Admin,
  workspaceId: string,
  action: PendingAction,
): Promise<{ ok: boolean; error?: string; tier?: ModelTier | null }> {
  const targetKind = action.target_kind;
  const payload = action.payload as ModelTierProposalPayload | undefined;
  if (!targetKind || !payload) return { ok: false, error: "action is missing target_kind / payload" };
  const r = await applyModelTierChange(admin, {
    workspaceId,
    kind: targetKind,
    tier: payload.proposedTier,
    proposedBy: payload.proposerFunction,
    approvedBy: payload.routedTo || CEO,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, tier: payload.proposedTier };
}
