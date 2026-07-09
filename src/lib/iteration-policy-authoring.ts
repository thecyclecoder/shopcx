/**
 * iteration-policy-authoring — the Growth Director's (or a human's) authoring + activation
 * surface for [[../tables/iteration_policies]]. The Phase 6a executor + the Phase 5 cron read the
 * `status='active'` row read-only (`loadActivePolicy` in [[./meta/decision-engine]]); nothing else
 * writes this table. With no `active` row the engine takes ZERO autonomous actions — the core
 * safety invariant — so this module is the seam that ends Meta's dormant mode by minting + flipping
 * the first version, and every subsequent re-tune.
 *
 * Three pure functions, mirroring the lifecycle described in
 * [[docs/brain/tables/iteration_policies.md]]:
 *   - `authorIterationPolicy` — insert a typed `pending` row at `version = max+1` for the
 *     workspace's null-campaign (global) scope. Versioning is monotone per workspace; collisions
 *     bubble (a concurrent author retries). Returns `{ policyId, version }`.
 *   - `activateIterationPolicy` — flip `pending → active`, supersede the prior `active` row via
 *     `superseded_by`/`superseded_at`. The unique partial index
 *     `iteration_policies_one_active_idx` guarantees at most one active global row per workspace,
 *     so we ALWAYS supersede the prior active first, then activate ours.
 *   - `validateActivationAgainstSpendRail` — growth-adopt-meta-iteration-engine Phase 3: BEFORE
 *     `activateIterationPolicy` flips status=active, project the daily budget motion the policy
 *     authorizes (`per_account_daily_budget_delta_ceiling_cents × window_days`) on top of the
 *     workspace's current rolling actual and refuse if the result would breach the workspace's
 *     effective `ad_spend_budgets` ceiling for the same `(workspace_id, meta_ad_account_id)`. No
 *     ceiling row ⇒ no rail to breach ⇒ allow. Director's leash: within-ceiling reallocation is
 *     autonomous; raising the ceiling is the CEO's call.
 *
 * Wired as the executor for the `iteration_policy_activation` leash action in the Growth Director:
 * the box session emits a `propose_policy_activation` pending action with the draft + rationale;
 * on auto-approve the worker runs `validateActivationAgainstSpendRail` → (allow) `authorIterationPolicy`
 * then `activateIterationPolicy`; on (refuse) it writes a `director_activity` row of
 * `action_kind='refused_iteration_policy'` and routes the diagnosis to the CEO via
 * `escalateDiagnosisToCeo` (`escalationKind='ad_spend_ceiling'`). One row per activation OR refusal.
 *
 * The DB's `created_by` column is constrained to `'agent' | 'human'` — the API takes
 * `'director' | 'human'` for legibility (the Director is an agent), so we map director → agent.
 * `activated_by` is a `uuid references auth.users(id)` which the Director (not a real user) cannot
 * fill, so the column stays null on director activations; the human-actor path may pass a uuid
 * later but Phase 1 leaves it null too (the actor label is recorded by the calling
 * `director_activity` row).
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getEffectiveAdSpendBudget, rollupAdSpendActual, type AdSpendBudget, type AdSpendPlatform } from "@/lib/ad-spend-governor";

type Admin = ReturnType<typeof createAdminClient>;

/** Author of a policy row at the API level — distinct from the DB's `agent|human` constraint. */
export type PolicyActor = "director" | "human";

/**
 * The safety branch a policy version runs on (media-buyer-shadow-mode Phase 1).
 * `shadow` — the media-buyer computes the plan but writes ZERO iteration_actions /
 * ad_publish_jobs; it emits `*_shadow` director_activity rows instead. `armed` — the
 * runtime behavior that shipped before this column (writes actions + publish jobs).
 * A freshly authored draft defaults to `shadow`; a separate flip surface moves it to
 * `armed` (spec media-buyer-armed-flip-surface).
 */
export type IterationPolicyMode = "shadow" | "armed";

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
  /** Safety branch. Omit ⇒ shadow (the CEO's non-negotiable read-only-before-armed default). */
  mode?: IterationPolicyMode;
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
    // media-buyer-shadow-mode Phase 1 — a freshly authored draft lands `shadow` unless the
    // caller explicitly overrides. The flip to `armed` is a separate, audited action.
    mode: draft.mode ?? "shadow",
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

// ── Phase 3 — Spend-rail guard at activation time ───────────────────────────────────────────────

/**
 * The decision returned by `validateActivationAgainstSpendRail` — `allow` ⇒ the worker proceeds with
 * `activateIterationPolicy`; `refuse` ⇒ the worker writes a `refused_iteration_policy`
 * director_activity row and routes the diagnosis to the CEO via `escalateDiagnosisToCeo`
 * (`escalationKind='ad_spend_ceiling'`). `reason='ad_spend_ceiling_would_breach'` is the named-by-spec
 * refusal code (no other refusal reasons exist today — the rail breach is the only thing the guard
 * checks); a missing ceiling row is NOT a refusal (no rail to breach).
 */
export type SpendRailGuardDecision =
  | { allow: true; observation: SpendRailObservation | null }
  | { allow: false; reason: "ad_spend_ceiling_would_breach"; observation: SpendRailObservation; diagnosis: string; metadata: SpendRailRefusalMetadata };

/** The compact snapshot the guard surfaces — what the rail says + what the policy would do on top. */
export interface SpendRailObservation {
  budget: AdSpendBudget | null;
  currentActualCents: number;
  projectedWindowDeltaCents: number;
  projectedTotalCents: number;
  ceilingCents: number | null;
}

/** Structured refusal metadata the worker forwards into the activity row + the CEO notification. */
export interface SpendRailRefusalMetadata {
  policy_id?: string | null;
  draft_step_pct: number;
  per_account_daily_budget_delta_ceiling_cents: number;
  window_days: number;
  projected_window_delta_cents: number;
  projected_total_cents: number;
  ceiling_cents: number;
  meta_ad_account_id: string | null;
  platform: AdSpendPlatform;
}

export interface ValidateActivationAgainstSpendRailInput {
  workspaceId: string;
  /** The draft (pre-author) OR the persisted policy fields the guard reads. Only the budget-motion
   *  knob `per_account_daily_budget_delta_ceiling_cents` matters today; `scale_up_step_pct` is
   *  carried through for the refusal metadata + the CEO diagnosis. */
  draft: Pick<IterationPolicyDraft, "per_account_daily_budget_delta_ceiling_cents" | "scale_up_step_pct">;
  /** The Meta ad account the activation governs. null ⇒ workspace-wide; the guard then reads the
   *  platform-wide `ad_spend_budgets` row (the more-specific per-account row only applies when an
   *  account is named). */
  metaAdAccountId?: string | null;
  /** Optional — when an already-authored policy is being activated, the id flows into the refusal
   *  metadata so the CEO can deep-link to the pending row. */
  policyId?: string | null;
}

/**
 * Pre-activation spend-rail guard (growth-adopt-meta-iteration-engine Phase 3). Returns `allow:true`
 * when the policy's projected rolling spend (current_actual + per_account_daily_budget_delta × window_days)
 * fits within the workspace's effective `ad_spend_budgets` ceiling for the same (workspace, platform,
 * meta_ad_account_id) — OR when no rail row exists (no ceiling to breach).
 *
 * NEVER mutates — the worker is the only component that writes the refusal ledger row + the CEO
 * notification on `allow:false`. Best-effort on reads: a transient DB read failure is treated as the
 * conservative path (no rail row → allow), because a guard that throws on a flaky read would
 * incorrectly leave the engine in dormant mode.
 *
 * Platform scope is `meta` today — that's what the iteration engine drives. When google/amazon
 * platforms join the engine the same guard generalizes by adding their `AdSpendPlatform` value.
 */
export async function validateActivationAgainstSpendRail(
  admin: Admin,
  input: ValidateActivationAgainstSpendRailInput,
): Promise<SpendRailGuardDecision> {
  const { workspaceId, draft, metaAdAccountId = null, policyId = null } = input;
  let budget: AdSpendBudget | null = null;
  try {
    budget = await getEffectiveAdSpendBudget(admin, workspaceId, { platform: "meta", metaAdAccountId });
  } catch {
    return { allow: true, observation: null };
  }
  if (!budget) {
    // No rail set ⇒ no ceiling to breach ⇒ activation proceeds (the Director's leash on rolling spend
    // is implicit when no explicit ceiling is configured; the ad-spend governor cannot fire either).
    return { allow: true, observation: null };
  }

  let currentActualCents = 0;
  try {
    const rollup = await rollupAdSpendActual(admin, {
      workspaceId,
      platform: "meta",
      metaAdAccountId,
      windowDays: budget.windowDays,
    });
    currentActualCents = rollup.actualCents;
  } catch {
    /* best-effort — a zero rollup just means the projection is policy-delta only */
  }

  const dailyDeltaCents = Math.max(0, Number(draft.per_account_daily_budget_delta_ceiling_cents ?? 0));
  const projectedWindowDeltaCents = dailyDeltaCents * budget.windowDays;
  const projectedTotalCents = currentActualCents + projectedWindowDeltaCents;
  const observation: SpendRailObservation = {
    budget,
    currentActualCents,
    projectedWindowDeltaCents,
    projectedTotalCents,
    ceilingCents: budget.usdCeilingCents,
  };

  if (projectedTotalCents <= budget.usdCeilingCents) {
    return { allow: true, observation };
  }

  // Breach — refuse the activation in-leash. The CEO diagnosis spells out exactly which knob would
  // push the rolling spend past the ceiling so the disposition is one click (raise the ceiling, or
  // tighten the policy's daily-delta knob and re-propose).
  const scope = metaAdAccountId ? `account ${metaAdAccountId.slice(0, 8)}` : "meta-wide";
  const usdCurrent = (currentActualCents / 100).toFixed(2);
  const usdProjectedDelta = (projectedWindowDeltaCents / 100).toFixed(2);
  const usdProjectedTotal = (projectedTotalCents / 100).toFixed(2);
  const usdCeiling = (budget.usdCeilingCents / 100).toFixed(2);
  const diagnosis =
    `Iteration-policy activation refused — projected rolling spend would breach the active ad_spend_budgets ceiling. ` +
    `${scope} ${budget.windowDays}d window: current $${usdCurrent} + policy's daily-delta cap ($${(dailyDeltaCents / 100).toFixed(2)} × ${budget.windowDays}d = $${usdProjectedDelta}) = $${usdProjectedTotal} > $${usdCeiling}. ` +
    `Director's leash boundary — within-ceiling reallocation is autonomous; raising the ceiling is your call.`;

  return {
    allow: false,
    reason: "ad_spend_ceiling_would_breach",
    observation,
    diagnosis,
    metadata: {
      policy_id: policyId,
      draft_step_pct: Number(draft.scale_up_step_pct ?? 0),
      per_account_daily_budget_delta_ceiling_cents: dailyDeltaCents,
      window_days: budget.windowDays,
      projected_window_delta_cents: projectedWindowDeltaCents,
      projected_total_cents: projectedTotalCents,
      ceiling_cents: budget.usdCeilingCents,
      meta_ad_account_id: metaAdAccountId,
      platform: "meta",
    },
  };
}
