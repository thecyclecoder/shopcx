/**
 * iteration-policy-authoring — the Growth Director's (or a human's) authoring + activation
 * surface for [[../tables/iteration_policies]]. The Phase 6a executor + the Phase 5 cron read the
 * `status='active'` row read-only (`loadActivePolicy` in [[./meta/decision-engine]]); nothing else
 * writes this table. With no `active` row the engine takes ZERO autonomous actions — the core
 * safety invariant — so this module is the seam that ends Meta's dormant mode by minting + flipping
 * the first version, and every subsequent re-tune.
 *
 * Two pure functions, mirroring the lifecycle described in
 * [[docs/brain/tables/iteration_policies.md]]:
 *   - `authorIterationPolicy` — insert a typed `pending` row at `version = max+1` for the
 *     workspace's null-campaign (global) scope. Versioning is monotone per workspace; collisions
 *     bubble (a concurrent author retries). Returns `{ policyId, version }`.
 *   - `activateIterationPolicy` — flip `pending → active`, supersede the prior `active` row via
 *     `superseded_by`/`superseded_at`. The unique partial index
 *     `iteration_policies_one_active_idx` guarantees at most one active global row per workspace,
 *     so we ALWAYS supersede the prior active first, then activate ours.
 *
 * Wired as the executor for the `iteration_policy_activation` leash action in the Growth Director:
 * the box session emits a `propose_policy_activation` pending action with the draft + rationale;
 * on auto-approve the worker runs `authorIterationPolicy` then `activateIterationPolicy` and writes
 * a `director_activity` row (`action_kind='activated_iteration_policy'`).
 *
 * The DB's `created_by` column is constrained to `'agent' | 'human'` — the API takes
 * `'director' | 'human'` for legibility (the Director is an agent), so we map director → agent.
 * `activated_by` is a `uuid references auth.users(id)` which the Director (not a real user) cannot
 * fill, so the column stays null on director activations; the human-actor path may pass a uuid
 * later but Phase 1 leaves it null too (the actor label is recorded by the calling
 * `director_activity` row).
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Author of a policy row at the API level — distinct from the DB's `agent|human` constraint. */
export type PolicyActor = "director" | "human";

/**
 * The typed, editable thresholds the engine reads. Matches the non-id/non-status columns on
 * `iteration_policies` 1:1 so the Director (and a human) can build one with no field-name guessing.
 */
export interface IterationPolicyDraft {
  roas_floor: number;
  scale_up_roas_trigger: number;
  scale_up_step_pct: number;
  scale_up_cap_pct: number;
  scale_down_step_pct: number;
  pause_min_spend_cents: number;
  pause_window_days: number;
  unpause_sales_after_pause: number;
  unpause_lookback_days: number;
  min_creatives_per_adset: number;
  per_object_cooldown_hours: number;
  per_account_daily_budget_delta_ceiling_cents: number;
  min_budget_floor_cents?: number | null;
  never_pause_object_ids?: string[];
}

export interface AuthorIterationPolicyInput {
  workspaceId: string;
  draft: IterationPolicyDraft;
  createdBy: PolicyActor;
  rationale: string;
}

export interface AuthorIterationPolicyResult {
  policyId: string;
  version: number;
}

/**
 * Insert one pending `iteration_policies` row at `version = max+1` for the workspace's
 * null-campaign global scope. Pending rows are inert (the engine only reads `active`); a separate
 * `activateIterationPolicy` flip puts it into rotation. The DB's CHECK constraint accepts only
 * `agent | human` for `created_by`; the API's `'director'` collapses to `agent` (the director IS an
 * agent — the actor distinction is recorded by the matching `director_activity` row).
 */
export async function authorIterationPolicy(
  admin: Admin,
  input: AuthorIterationPolicyInput,
): Promise<AuthorIterationPolicyResult> {
  const { workspaceId, draft, createdBy, rationale } = input;

  // Resolve the next version number for the workspace's null-campaign scope. The unique partial
  // index `(workspace_id, version) where campaign_id is null` makes the per-scope max meaningful;
  // a concurrent author would collide on the insert and the caller can retry.
  const { data: maxRow, error: maxErr } = await admin
    .from("iteration_policies")
    .select("version")
    .eq("workspace_id", workspaceId)
    .is("campaign_id", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) {
    throw new Error(`authorIterationPolicy: failed to resolve max version — ${maxErr.message}`);
  }
  const version = Number(maxRow?.version ?? 0) + 1;

  const row = {
    workspace_id: workspaceId,
    meta_ad_account_id: null,
    campaign_id: null,
    version,
    status: "pending",
    created_by: createdBy === "human" ? "human" : "agent",
    rationale,
    roas_floor: draft.roas_floor,
    scale_up_roas_trigger: draft.scale_up_roas_trigger,
    scale_up_step_pct: draft.scale_up_step_pct,
    scale_up_cap_pct: draft.scale_up_cap_pct,
    scale_down_step_pct: draft.scale_down_step_pct,
    pause_min_spend_cents: draft.pause_min_spend_cents,
    pause_window_days: draft.pause_window_days,
    unpause_sales_after_pause: draft.unpause_sales_after_pause,
    unpause_lookback_days: draft.unpause_lookback_days,
    min_creatives_per_adset: draft.min_creatives_per_adset,
    per_object_cooldown_hours: draft.per_object_cooldown_hours,
    per_account_daily_budget_delta_ceiling_cents: draft.per_account_daily_budget_delta_ceiling_cents,
    min_budget_floor_cents: draft.min_budget_floor_cents ?? null,
    never_pause_object_ids: draft.never_pause_object_ids ?? [],
  };

  const { data, error } = await admin
    .from("iteration_policies")
    .insert(row)
    .select("id, version")
    .single();
  if (error || !data) {
    throw new Error(`authorIterationPolicy: insert failed — ${error?.message ?? "no row returned"}`);
  }
  return { policyId: data.id as string, version: Number(data.version) };
}

export interface ActivateIterationPolicyInput {
  workspaceId: string;
  policyId: string;
  activatedBy: PolicyActor;
}

export interface ActivateIterationPolicyResult {
  activated: boolean;
  supersededPolicyId: string | null;
  version: number;
}

/**
 * Flip the pending policy to active and supersede the prior active row for the same
 * `(workspace_id, null campaign)` scope. The unique partial index `iteration_policies_one_active_idx`
 * enforces at most one active global row per workspace, so we MUST supersede the prior active
 * BEFORE flipping ours — otherwise the insert/update collides on the partial index. Idempotent on
 * the no-op cases (already active, no prior active to supersede) but throws when the policy is
 * missing or not in the activatable `pending` state.
 */
export async function activateIterationPolicy(
  admin: Admin,
  input: ActivateIterationPolicyInput,
): Promise<ActivateIterationPolicyResult> {
  const { workspaceId, policyId } = input;

  const { data: target, error: readErr } = await admin
    .from("iteration_policies")
    .select("id, workspace_id, version, status, campaign_id")
    .eq("id", policyId)
    .maybeSingle();
  if (readErr) {
    throw new Error(`activateIterationPolicy: failed to read policy ${policyId} — ${readErr.message}`);
  }
  if (!target) {
    throw new Error(`activateIterationPolicy: policy ${policyId} not found`);
  }
  if (target.workspace_id !== workspaceId) {
    throw new Error(
      `activateIterationPolicy: policy ${policyId} belongs to workspace ${target.workspace_id}, not ${workspaceId}`,
    );
  }
  const version = Number(target.version);

  // Idempotent on the already-active case — no double-activation work, no audit drift.
  if (target.status === "active") {
    return { activated: false, supersededPolicyId: null, version };
  }
  if (target.status !== "pending") {
    throw new Error(`activateIterationPolicy: policy ${policyId} status='${target.status}' (only 'pending' is activatable)`);
  }

  // Find the current active row for the SAME null-campaign scope (we activate global policies only;
  // a per-campaign override would be supersession-scoped to its own (account, campaign) bucket).
  const { data: priorActive, error: priorErr } = await admin
    .from("iteration_policies")
    .select("id")
    .eq("workspace_id", workspaceId)
    .is("campaign_id", null)
    .eq("status", "active")
    .maybeSingle();
  if (priorErr) {
    throw new Error(`activateIterationPolicy: failed to scan prior active — ${priorErr.message}`);
  }

  const now = new Date().toISOString();

  // Supersede the prior active FIRST so the unique partial index has room for the new active row.
  let supersededPolicyId: string | null = null;
  if (priorActive?.id) {
    const { error: supErr } = await admin
      .from("iteration_policies")
      .update({
        status: "superseded",
        superseded_by: policyId,
        superseded_at: now,
        updated_at: now,
      })
      .eq("id", priorActive.id);
    if (supErr) {
      throw new Error(`activateIterationPolicy: failed to supersede prior active ${priorActive.id} — ${supErr.message}`);
    }
    supersededPolicyId = priorActive.id as string;
  }

  // Flip ours to active. `activated_by` is a uuid → auth.users; the Director (and the human caller
  // routed via this surface in Phase 1) doesn't carry a uid here, so the column stays null and the
  // matching director_activity row records the actor label.
  const { error: actErr } = await admin
    .from("iteration_policies")
    .update({
      status: "active",
      activated_by: null,
      activated_at: now,
      updated_at: now,
    })
    .eq("id", policyId);
  if (actErr) {
    throw new Error(`activateIterationPolicy: failed to activate ${policyId} — ${actErr.message}`);
  }

  return { activated: true, supersededPolicyId, version };
}
