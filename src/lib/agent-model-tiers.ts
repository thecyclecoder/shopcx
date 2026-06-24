/**
 * Per-agent model-tier registry (box-agent-model-tiers spec) — the LOCKED config that tiers each box
 * `claude -p` agent kind by task.
 *
 * Every box agent (the org-chart workers Bo/build, Rafa/repair, Fenn/fold … AND the director Ada)
 * inherits the one Max-plan default model unless this registry pins its kind to a tier. `modelForKind`
 * is the box's per-claimed-job lookup: kind → a src/lib/ai-models MODELS id, or null (unset ⇒ no
 * --model ⇒ the Max default, today's behavior — an unset kind never regresses).
 *
 * The Max nuance (box-multi-account-failover): agents run on the Max subscription with
 * ANTHROPIC_API_KEY stripped → $0 marginal per token. A smaller tier is NOT a dollar saving — its
 * value is SPEED (a Haiku turn finishes faster) and LESS 5-hour-usage-window pressure (the real scarce
 * resource on Max). Reserve opus for quality-critical agents; put mechanical, high-volume agents on a
 * smaller, faster tier.
 *
 * Governance (Phase 3): a tier changes ONLY through the director→supervisor proposal flow
 * (`proposeModelTierChange` → approval → `applyModelTierChange`), never a silent edit. The change is an
 * approval_decisions-logged action (auditable, mirrors the leash) and reversible (flip the row back),
 * so it is a low-risk, in-leash config change with no deploy.
 *
 * See docs/brain/tables/agent_model_tiers.md and docs/brain/libraries/agent-model-tiers.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { MODELS, type ModelTier } from "@/lib/ai-models";

type Admin = ReturnType<typeof createAdminClient>;

/** One row of public.agent_model_tiers. */
export interface AgentModelTierRow {
  id: string;
  workspace_id: string;
  agent_kind: string;
  model_tier: ModelTier | null;
  proposed_by: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A tier value is one of the MODELS keys, or null (= unset = the Max default). */
export function isModelTier(v: unknown): v is ModelTier {
  return v === "haiku" || v === "sonnet" || v === "opus";
}

/**
 * Resolve a job kind's pinned model id for the box. Returns a src/lib/ai-models MODELS id (e.g. the
 * opus id) when a tier is set for `(workspaceId, kind)`, else NULL — null means "pass no --model flag"
 * so the box stays on the Max default (no regression for any unset kind).
 *
 * Best-effort by construction: any read error (missing table pre-migration, transient) resolves to
 * null so the box never fails to launch a job over a registry hiccup — it just runs the Max default.
 */
export async function modelForKind(
  admin: Admin,
  workspaceId: string,
  kind: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("agent_model_tiers")
    .select("model_tier")
    .eq("workspace_id", workspaceId)
    .eq("agent_kind", kind)
    .maybeSingle();
  if (error || !data) return null;
  const tier = (data as { model_tier: string | null }).model_tier;
  return isModelTier(tier) ? MODELS[tier] : null;
}

/** The full registry for a workspace (the Agents-hub / profile read), newest-updated first. */
export async function listModelTiers(
  admin: Admin,
  workspaceId: string,
): Promise<AgentModelTierRow[]> {
  const { data, error } = await admin
    .from("agent_model_tiers")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });
  if (error || !data) return [];
  return data as AgentModelTierRow[];
}

/** One kind's current tier row (or null when unset = the Max default). */
export async function getModelTier(
  admin: Admin,
  workspaceId: string,
  kind: string,
): Promise<AgentModelTierRow | null> {
  const { data, error } = await admin
    .from("agent_model_tiers")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("agent_kind", kind)
    .maybeSingle();
  if (error || !data) return null;
  return data as AgentModelTierRow;
}

/**
 * Apply a model-tier change (Phase 3) — the single write chokepoint. Upserts the
 * `(workspace_id, agent_kind)` row to `tier` (null clears it back to the Max default) and stamps the
 * proposing + approving org-chart functions for provenance. Reversible: call again with the prior tier.
 *
 * This is the ONLY place that mutates a tier — every caller (the seed, the approved proposal, a CEO
 * coaching edit) goes through here so the provenance stamps + updated_at stay consistent.
 */
export async function applyModelTierChange(
  admin: Admin,
  input: {
    workspaceId: string;
    kind: string;
    tier: ModelTier | null;
    proposedBy: string | null;
    approvedBy: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const now = new Date().toISOString();
  const { error } = await admin
    .from("agent_model_tiers")
    .upsert(
      {
        workspace_id: input.workspaceId,
        agent_kind: input.kind,
        model_tier: input.tier,
        proposed_by: input.proposedBy,
        approved_by: input.approvedBy,
        updated_at: now,
      },
      { onConflict: "workspace_id,agent_kind" },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
