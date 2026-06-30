/**
 * Growth Director agent (growth-director-agent spec, Phases 1–3) — the SECOND live director, after Ada.
 *
 * North star (operational-rules § supervisable autonomy): CEO → Director → tool. The Growth tools
 * (iteration policies, storefront optimizer, Meta creative actions, ad-spend reallocation, ad-publish)
 * already work; nobody SUPERVISES them as a director. This module mirrors `platform-director`:
 *   - Phase 1 — the LEASH_CATEGORIES union, the per-action leash gate, `growthIsAutoApprover`.
 *   - Phase 2 — `buildGrowthDirectorBrief` (read-only loader of the Growth control surfaces — function
 *     autonomy row + the iteration_policies version ledger + the storefront_optimizer_policy row + the
 *     open iteration_recommendations) + `growthDirectorInvestigationPrompt` (the Max `claude -p`
 *     prompt wrapped with `directorLiveStateFact(admin,'growth')` so the verdict is premised on the
 *     LIVE flag, never on stale brain prose). The session emits ONE JSON verdict `auto-approve|escalate`.
 *   - Phase 3 — `routesToGrowth` + `enqueueGrowthDirectorJobs` (the throttled sweep that queues one
 *     idempotent `kind='growth-director'` job per open Growth-routed Approval Request) +
 *     `applyDirectorApproval` (mark `approved` + flip to `queued_resume` + log the supervisable-
 *     autonomy ledger row with `routed_to_function='growth'`). The box worker (`runGrowthDirectorJob`)
 *     loads the brief, runs the Max investigation, and on `auto-approve` calls `applyDirectorApproval`
 *     or on `escalate` re-routes via `escalateApprovalRequestToCeo` (reused from platform-director,
 *     parameterized by director identity so the CEO inbox notification carries "Growth Director"
 *     instead of Ada). A `director_activity` row is written per decision (`director_function='growth'`,
 *     `action_kind='approved_approval'|'escalated'`).
 *
 * Build-driving stays with Ada permanently (CEO directive 2026-06-29) — Growth OPERATES its software,
 * never builds.
 *
 * Activation is owner-confirmed and lands later (M6 flag flip): until `function_autonomy('growth')` is
 * `live + autonomous`, `resolveApprover` never routes a Growth-owned tool's approval here, so the
 * enqueuer is a no-op — the machinery is built but dormant.
 *
 * See docs/brain/specs/growth-director-agent.md · docs/brain/libraries/platform-director.md.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  buildOrgChartGraph,
  isAutoApprover,
  loadAutonomyMap,
  resolveApprover,
  type AutonomyMap,
  type OrgChartGraph,
} from "@/lib/agents/approval-router";
import { ownerFunctionForKind } from "@/lib/agents/approval-inbox";
import { recordApprovalDecision } from "@/lib/agents/approval-decisions";
import { directorLiveStateFact } from "@/lib/agents/platform-director";
import {
  listAdSpendBudgets,
  rollupAdSpendActual,
  type AdSpendBudget,
  type AdSpendRollup,
} from "@/lib/ad-spend-governor";

type Admin = ReturnType<typeof createAdminClient>;

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
  | "promote_ready_to_test_creative"
  | "approve_voice_angle";

export const LEASH_CATEGORIES: LeashCategory[] = [
  "iteration_policy_activation",
  "storefront_optimizer_policy_activation",
  "pause_underperforming_creative",
  "reallocate_within_ceiling",
  "promote_ready_to_test_creative",
  "approve_voice_angle",
];

/**
 * The pending-action types that are UNCONDITIONALLY leash candidates → their leash category. Each must
 * still pass the read-only investigation verdict (the soundness gate added in Phase 2). The mapping is
 * mostly 1:1 with the categories — Growth's pending-action `type` fields are named the same as the
 * leash categories themselves — with one alias: the iteration engine emits `propose_policy_activation`
 * (carrying the draft + rationale) which falls under the `iteration_policy_activation` leash class
 * (the executor that authors + activates lives in [[../iteration-policy-authoring]]; the worker runs
 * it after the Director auto-approves).
 *
 * Anything not in this map — including any non-binary CHOICE action (e.g. a multi-option budget
 * reallocation choice) — falls out of leash and escalates to the CEO.
 */
const LEASH_ACTION_TYPES: Record<string, LeashCategory> = {
  iteration_policy_activation: "iteration_policy_activation",
  propose_policy_activation: "iteration_policy_activation",
  storefront_optimizer_policy_activation: "storefront_optimizer_policy_activation",
  pause_underperforming_creative: "pause_underperforming_creative",
  reallocate_within_ceiling: "reallocate_within_ceiling",
  promote_ready_to_test_creative: "promote_ready_to_test_creative",
  approve_voice_angle: "approve_voice_angle",
};

/** A loosely-typed agent_jobs row as the worker/enqueuer reads it (Supabase returns untyped JSON). */
export interface DirectorActionLike {
  id?: string;
  type?: string;
  status?: string;
  summary?: string;
  preview?: string;
  cmd?: string;
  /** Per-action payload carried by self-executing leash actions (e.g. `promote_ready_to_test_creative`,
   * `approve_voice_angle`). Shape is action-specific; readers cast it. */
  payload?: unknown;
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

// ── Phase 2 — read-only brief + investigation prompt ─────────────────────────────────────────────
// The brief loads the Growth control surfaces the investigation reads aloud:
//   - function_autonomy('growth') — the LIVE flag (the same DB row directorLiveStateFact wraps the
//     prompt with). Sourced via `loadAutonomyMap` per spec; missing row ⇒ off (fail-safe).
//   - iteration_policies — the versioned policy ledger for the workspace + each version's status (the
//     `active` row is what the ad engine reads; `pending` rows are awaiting director activation; the
//     director must be able to see what was active before approving a new activation).
//   - storefront_optimizer_policy — the single-row optimizer gate for the workspace (on/off, scope,
//     auto_run_reversible) — what flipping `active` actually affects.
//   - iteration_recommendations — the open `pending` recommendation queue (so the director sees the
//     spend lines an approval will unlock or change).
//   - iteration_runs (latest row) + iteration_actions (latest-run outcomes mix + outcome_roas) —
//     growth-adopt-meta-iteration-engine Phase 2: the supervisability record + the realized
//     executed/failed/reversed/escalated breakdown that tells the Director whether the
//     previously-activated policy is HOLDING UP before it approves the next version.
// The brief itself is data only; the prompt is the wrap (with directorLiveStateFact prepended).
// `loadAutonomyMap` creates its own admin client internally — we read function_autonomy directly via
// the passed admin to keep this testable + keep one connection per call.

/** One row of public.iteration_policies the brief carries — the legibility fields the director reads. */
export interface IterationPolicySummary {
  id: string;
  version: number;
  status: "pending" | "active" | "superseded" | string;
  created_by: string | null;
  rationale: string | null;
  activated_at: string | null;
  superseded_at: string | null;
  created_at: string | null;
}

/** The current single-row optimizer policy for the workspace (the surface a policy-activation flips). */
export interface StorefrontOptimizerPolicySummary {
  id: string;
  active: boolean;
  product_scope: unknown;
  auto_run_reversible: boolean;
  rationale: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** One workspace ad-spend ceiling + its current rolling-window actual — the leash the director must see. */
export interface AdSpendBudgetSummary {
  budget: AdSpendBudget;
  /** Today's rolling-window actual spend (the same window the governor's `currentOver` check reads). */
  current: AdSpendRollup;
}

/** One open `pending` recommendation row — the spend lines the optimizer/Meta engine want to open. */
export interface IterationRecommendationSummary {
  id: string;
  action_type: string;
  title: string | null;
  rationale: string | null;
  persona: string | null;
  status: string;
  created_at: string | null;
}

/** One `iteration_runs` row — the latest pipeline run for the workspace (the supervisability record). */
export interface IterationRunSummary {
  id: string;
  status: string;
  snapshot_date: string | null;
  policy_active: boolean;
  policy_version_id: string | null;
  meta_ad_account_id: string | null;
  counts: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

/**
 * One `iteration_actions` outcome — the realized action ledger for the latest run. The grader uses
 * the (status, outcome_roas) mix as the "did the activated policy hold up" signal that replaces the
 * build-side repeat-failure count for policy-activation approvals.
 */
export interface IterationActionOutcomeSummary {
  id: string;
  action_type: string;
  status: string;
  rationale: string | null;
  outcome_roas: number | null;
  outcome_revenue_cents: number | null;
  outcome_window_days: number | null;
  guardrail: string | null;
  created_at: string | null;
}

/** One in-leash action inside the brief — what the investigation confirms is sound. */
export interface GrowthDirectorBriefAction {
  category: LeashCategory;
  summary: string;
  preview: string;
  cmd: string;
}

/** Per-proposed-angle summary loaded into the brief so the director reads the voice density without
 * a second DB hit. Populated only when the request carries ≥1 `approve_voice_angle` action. */
export interface ProposedVoiceAngleSummary {
  id: string;
  product_id: string;
  hook_one_liner: string | null;
  mechanism_claim: string | null;
  source_signal_counts: { positive: number; objection: number; use_case: number };
  matrix_overlap: number | null;
  density: number | null;
  score: number | null;
}

/** The read-only brief the Growth director investigates — the request + the loaded control surfaces. */
export interface GrowthDirectorBrief {
  jobId: string;
  workspaceId: string;
  kind: string;
  specSlug: string | null;
  /** every leash class in the request (one for single, ≥2 for a bundle). */
  categories: LeashCategory[];
  /** each in-leash action's summary/preview/cmd, in bundle order. */
  actions: GrowthDirectorBriefAction[];
  /** true when the request bundles >1 action (approved atomically, all-or-nothing). */
  multi: boolean;
  /** the growth row from function_autonomy (null when unreadable / missing). */
  growthAutonomy: { live: boolean; autonomous: boolean } | null;
  /** the latest N iteration_policies versions for the workspace, status included (newest first). */
  iterationPolicies: IterationPolicySummary[];
  /** the single optimizer-policy row for the workspace (null when none exists yet). */
  storefrontOptimizerPolicy: StorefrontOptimizerPolicySummary | null;
  /** the open `status='pending'` iteration_recommendations rows for the workspace (newest first). */
  pendingRecommendations: IterationRecommendationSummary[];
  /** the latest `iteration_runs` row for the workspace (null if the engine has never run). */
  latestIterationRun: IterationRunSummary | null;
  /**
   * `iteration_actions` outcomes (status + outcome_roas mix) for the latest run's account/snapshot.
   * The grader reads this as the realized signal — executed / failed / reversed / escalated — that
   * tells the Director whether the policy it activated is holding up.
   */
  iterationActionOutcomes: IterationActionOutcomeSummary[];
  /** every `ad_spend_budgets` row for the workspace + its current rolling-window actual — the leash. */
  adSpendBudgets: AdSpendBudgetSummary[];
  /** the proposed `product_ad_angles` rows targeted by `approve_voice_angle` actions in this request,
   * loaded so the prompt can render hook + score + voice density. Empty when no such actions exist. */
  proposedVoiceAngles: ProposedVoiceAngleSummary[];
  logTail: string;
}

/** How many iteration_policies versions + pending recommendations the brief carries — cap the prompt size. */
const POLICY_VERSIONS_CAP = 8;
const PENDING_RECOS_CAP = 25;
/** Cap on iteration_action outcomes carried in the brief — the grader summary doesn't need more. */
const ACTION_OUTCOMES_CAP = 50;

/**
 * Load every `ad_spend_budgets` row for the workspace + its CURRENT rolling-window actual (the
 * same rollup the governor's `currentOver` check reads, ending today UTC). This is what the
 * Growth director sees as its LEASH on every investigation — within-ceiling reallocation is
 * autonomous; raising the ceiling is the CEO's call.
 *
 * Best-effort: a transient read failure on either side (`listAdSpendBudgets` or `rollupAdSpendActual`)
 * returns the empty list / a zero rollup so the brief never throws (the prompt narrates the gap).
 */
export async function loadEffectiveAdSpendBudgets(
  admin: Admin,
  workspaceId: string,
): Promise<AdSpendBudgetSummary[]> {
  let budgets: AdSpendBudget[] = [];
  try {
    budgets = await listAdSpendBudgets(admin, workspaceId);
  } catch {
    return [];
  }
  const summaries: AdSpendBudgetSummary[] = [];
  for (const budget of budgets) {
    let current: AdSpendRollup;
    try {
      current = await rollupAdSpendActual(admin, {
        workspaceId: budget.workspaceId,
        platform: budget.platform,
        metaAdAccountId: budget.metaAdAccountId,
        windowDays: budget.windowDays,
      });
    } catch {
      const today = new Date().toISOString().slice(0, 10);
      const since = new Date(`${today}T00:00:00Z`);
      since.setUTCDate(since.getUTCDate() - (budget.windowDays - 1));
      current = {
        actualCents: 0,
        toDate: today,
        sinceDate: since.toISOString().slice(0, 10),
        windowDays: budget.windowDays,
      };
    }
    summaries.push({ budget, current });
  }
  return summaries;
}

/**
 * Load the Growth director's brief — every loader is best-effort + returns the empty/null shape on
 * failure, so a transient read error never blocks the investigation (the prompt then notes the gap).
 */
export async function buildGrowthDirectorBrief(
  admin: Admin,
  job: DirectorTargetJob,
  candidates: LeashAction[],
): Promise<GrowthDirectorBrief> {
  const actions: GrowthDirectorBriefAction[] = candidates.map((c) => {
    const a = (job.pending_actions || []).find((p) => p.id === c.actionId) ?? {};
    return { category: c.category, summary: a.summary || "", preview: a.preview || "", cmd: a.cmd || "" };
  });

  // function_autonomy('growth') — the same DB row directorLiveStateFact wraps; we load it INTO the brief
  // so any down-stream caller (logging, the disposition lane) can see the flag without a second read.
  let growthAutonomy: GrowthDirectorBrief["growthAutonomy"] = null;
  try {
    const { data } = await admin
      .from("function_autonomy")
      .select("live, autonomous")
      .eq("function_slug", GROWTH)
      .maybeSingle();
    if (data) growthAutonomy = { live: !!data.live, autonomous: !!data.autonomous };
  } catch {
    /* best-effort — prompt narrates the gap */
  }

  // The versioned policy ledger — newest first. We carry the `pending` + `active` versions explicitly
  // (the verification asserts the brief includes both), bounded by POLICY_VERSIONS_CAP so a long ledger
  // doesn't blow up the prompt.
  let iterationPolicies: IterationPolicySummary[] = [];
  try {
    const { data } = await admin
      .from("iteration_policies")
      .select("id, version, status, created_by, rationale, activated_at, superseded_at, created_at")
      .eq("workspace_id", job.workspace_id)
      .order("version", { ascending: false })
      .limit(POLICY_VERSIONS_CAP);
    iterationPolicies = ((data || []) as IterationPolicySummary[]).map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      created_by: r.created_by ?? null,
      rationale: r.rationale ?? null,
      activated_at: r.activated_at ?? null,
      superseded_at: r.superseded_at ?? null,
      created_at: r.created_at ?? null,
    }));
  } catch {
    /* best-effort */
  }

  // The single-row optimizer policy for the workspace — what flipping `active` actually toggles.
  let storefrontOptimizerPolicy: StorefrontOptimizerPolicySummary | null = null;
  try {
    const { data } = await admin
      .from("storefront_optimizer_policy")
      .select("id, active, product_scope, auto_run_reversible, rationale, updated_by, updated_at")
      .eq("workspace_id", job.workspace_id)
      .maybeSingle();
    if (data) {
      storefrontOptimizerPolicy = {
        id: data.id,
        active: !!data.active,
        product_scope: data.product_scope ?? [],
        auto_run_reversible: !!data.auto_run_reversible,
        rationale: data.rationale ?? null,
        updated_by: data.updated_by ?? null,
        updated_at: data.updated_at ?? null,
      };
    }
  } catch {
    /* best-effort */
  }

  // The ad-spend leash — every active ceiling + its current rolling-window actual. Surfacing the
  // ad_spend_budgets here gives the director full visibility on the rail it MAY NOT breach (raising
  // the ceiling is the CEO's call) and the headroom every `reallocate_within_ceiling` decision has.
  let adSpendBudgets: AdSpendBudgetSummary[] = [];
  try {
    adSpendBudgets = await loadEffectiveAdSpendBudgets(admin, job.workspace_id);
  } catch {
    /* best-effort */
  }

  // The open `status='pending'` recommendations — the spend lines this approval could unlock or change.
  let pendingRecommendations: IterationRecommendationSummary[] = [];
  try {
    const { data } = await admin
      .from("iteration_recommendations")
      .select("id, action_type, title, rationale, persona, status, created_at")
      .eq("workspace_id", job.workspace_id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(PENDING_RECOS_CAP);
    pendingRecommendations = ((data || []) as IterationRecommendationSummary[]).map((r) => ({
      id: r.id,
      action_type: r.action_type,
      title: r.title ?? null,
      rationale: r.rationale ?? null,
      persona: r.persona ?? null,
      status: r.status,
      created_at: r.created_at ?? null,
    }));
  } catch {
    /* best-effort */
  }

  // growth-customer-voice-to-ad-angles Phase 3: when ≥1 leash action is `approve_voice_angle`,
  // load the proposed angle rows so the prompt renders the hook + voice density + score the
  // director judges. Workspace-scoped + bounded to the ids the actions carry.
  let proposedVoiceAngles: ProposedVoiceAngleSummary[] = [];
  const voiceAngleIds = Array.from(
    new Set(
      candidates
        .filter((c) => c.category === "approve_voice_angle")
        .map((c) => {
          const a = (job.pending_actions || []).find((p) => p.id === c.actionId);
          const ang = (a?.payload as { angle_id?: string } | null)?.angle_id;
          return typeof ang === "string" ? ang : "";
        })
        .filter(Boolean),
    ),
  );
  if (voiceAngleIds.length) {
    try {
      const { data } = await admin
        .from("product_ad_angles")
        .select("id, product_id, hook_one_liner, metadata")
        .eq("workspace_id", job.workspace_id)
        .in("id", voiceAngleIds);
      proposedVoiceAngles = ((data || []) as Array<{
        id: string;
        product_id: string;
        hook_one_liner: string | null;
        metadata: {
          mined_from?: { review_ids?: string[]; cancel_event_ids?: string[]; ticket_ids?: string[] };
          mechanism_claim?: string;
          matrix_overlap?: number;
          density?: number;
          score?: number;
        } | null;
      }>).map((r) => {
        const m = r.metadata ?? {};
        const mined = m.mined_from ?? {};
        return {
          id: r.id,
          product_id: r.product_id,
          hook_one_liner: r.hook_one_liner ?? null,
          mechanism_claim: typeof m.mechanism_claim === "string" ? m.mechanism_claim : null,
          source_signal_counts: {
            positive: Array.isArray(mined.review_ids) ? mined.review_ids.length : 0,
            objection: Array.isArray(mined.cancel_event_ids) ? mined.cancel_event_ids.length : 0,
            use_case: Array.isArray(mined.ticket_ids) ? mined.ticket_ids.length : 0,
          },
          matrix_overlap: typeof m.matrix_overlap === "number" ? m.matrix_overlap : null,
          density: typeof m.density === "number" ? m.density : null,
          score: typeof m.score === "number" ? m.score : null,
        };
      });
    } catch {
      /* best-effort — prompt narrates the gap */
    }
  }

  // The latest iteration_runs row — the supervisability record for the engine's most recent pipeline
  // execution (ingest → attribution → rollups → reconcile → 4a actions → 4b recommendations → 6a).
  // This is the audit trail the Director MUST see before approving a new policy activation, and the
  // anchor the grader's outcome signal hangs off (the run's iteration_actions outcomes below).
  let latestIterationRun: IterationRunSummary | null = null;
  try {
    const { data } = await admin
      .from("iteration_runs")
      .select("id, status, snapshot_date, policy_active, policy_version_id, meta_ad_account_id, counts, error, started_at, finished_at, duration_ms")
      .eq("workspace_id", job.workspace_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      latestIterationRun = {
        id: data.id as string,
        status: data.status as string,
        snapshot_date: (data.snapshot_date as string | null) ?? null,
        policy_active: !!data.policy_active,
        policy_version_id: (data.policy_version_id as string | null) ?? null,
        meta_ad_account_id: (data.meta_ad_account_id as string | null) ?? null,
        counts: (data.counts as Record<string, unknown> | null) ?? null,
        error: (data.error as string | null) ?? null,
        started_at: (data.started_at as string | null) ?? null,
        finished_at: (data.finished_at as string | null) ?? null,
        duration_ms: data.duration_ms == null ? null : Number(data.duration_ms),
      };
    }
  } catch {
    /* best-effort */
  }

  // The iteration_actions outcomes (status + outcome_roas mix) for the latest run's account on the
  // run's snapshot day — the realized executed/failed/reversed/escalated breakdown the grader uses to
  // judge whether the previously-activated policy is holding up. Scoped by snapshot_date so a re-run
  // doesn't bleed in unrelated days. Skipped if the latest run never decided a snapshot day yet.
  let iterationActionOutcomes: IterationActionOutcomeSummary[] = [];
  try {
    if (latestIterationRun?.snapshot_date && latestIterationRun?.meta_ad_account_id) {
      const { data } = await admin
        .from("iteration_actions")
        .select("id, action_type, status, rationale, outcome_roas, outcome_revenue_cents, outcome_window_days, guardrail, created_at")
        .eq("workspace_id", job.workspace_id)
        .eq("meta_ad_account_id", latestIterationRun.meta_ad_account_id)
        .eq("snapshot_date", latestIterationRun.snapshot_date)
        .order("created_at", { ascending: false })
        .limit(ACTION_OUTCOMES_CAP);
      iterationActionOutcomes = ((data || []) as Array<{
        id: string;
        action_type: string;
        status: string;
        rationale: string | null;
        outcome_roas: number | string | null;
        outcome_revenue_cents: number | string | null;
        outcome_window_days: number | string | null;
        guardrail: string | null;
        created_at: string | null;
      }>).map((r) => ({
        id: r.id,
        action_type: r.action_type,
        status: r.status,
        rationale: r.rationale ?? null,
        outcome_roas: r.outcome_roas == null ? null : Number(r.outcome_roas),
        outcome_revenue_cents: r.outcome_revenue_cents == null ? null : Number(r.outcome_revenue_cents),
        outcome_window_days: r.outcome_window_days == null ? null : Number(r.outcome_window_days),
        guardrail: r.guardrail ?? null,
        created_at: r.created_at ?? null,
      }));
    }
  } catch {
    /* best-effort */
  }

  return {
    jobId: job.id,
    workspaceId: job.workspace_id,
    kind: job.kind,
    specSlug: job.spec_slug,
    categories: candidates.map((c) => c.category),
    actions,
    multi: actions.length > 1,
    growthAutonomy,
    iterationPolicies,
    storefrontOptimizerPolicy,
    pendingRecommendations,
    latestIterationRun,
    iterationActionOutcomes,
    adSpendBudgets,
    proposedVoiceAngles,
    logTail: (job.log_tail || "").slice(-2000),
  };
}

/** Render the iteration_policies ledger inside the prompt — compact, newest-first. */
function renderIterationPolicies(rows: IterationPolicySummary[]): string {
  if (!rows.length) return "iteration_policies: (no versions yet — the ad engine is fully idle until a director or human activates v1)";
  const lines = rows.map(
    (r) =>
      `  - v${r.version} · status=${r.status} · created_by=${r.created_by ?? "?"}${r.activated_at ? ` · activated ${r.activated_at}` : ""}${r.superseded_at ? ` · superseded ${r.superseded_at}` : ""}${r.rationale ? ` — ${r.rationale.slice(0, 200)}` : ""}`,
  );
  return ["iteration_policies (newest first):", ...lines].join("\n");
}

/** Render the storefront_optimizer_policy row inside the prompt — the single source of truth. */
function renderOptimizerPolicy(p: StorefrontOptimizerPolicySummary | null): string {
  if (!p) return "storefront_optimizer_policy: (no row — the optimizer is fully idle, propose-gate refuses everything)";
  const scope = Array.isArray(p.product_scope) ? p.product_scope.join(", ") : JSON.stringify(p.product_scope ?? []);
  return [
    "storefront_optimizer_policy:",
    `  - active=${p.active} · auto_run_reversible=${p.auto_run_reversible}`,
    `  - product_scope: [${scope}]`,
    p.rationale ? `  - rationale: ${p.rationale.slice(0, 300)}` : "",
    p.updated_at ? `  - last updated ${p.updated_at}${p.updated_by ? ` by ${p.updated_by}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Render the ad-spend ceilings + current rolling-window actuals — the director's leash. */
function renderAdSpendBudgets(rows: AdSpendBudgetSummary[]): string {
  if (!rows.length) {
    return "ad_spend_budgets: (no ad-spend ceilings configured — within-ceiling reallocation is unbounded; any spend-shifting action must escalate)";
  }
  const lines = rows.map((s) => {
    const scope = s.budget.metaAdAccountId ? `account ${s.budget.metaAdAccountId.slice(0, 8)}` : `${s.budget.platform}-wide`;
    const usdCeil = (s.budget.usdCeilingCents / 100).toFixed(2);
    const usdNow = (s.current.actualCents / 100).toFixed(2);
    const pct = s.budget.usdCeilingCents > 0
      ? Math.round((s.current.actualCents / s.budget.usdCeilingCents) * 100)
      : 0;
    return `  - ${s.budget.platform} · ${scope} · ${s.budget.windowDays}d ceiling=$${usdCeil} · current=$${usdNow} (${pct}% of ceiling, window ending ${s.current.toDate})`;
  });
  return ["ad_spend_budgets (rolling-window leash — within-ceiling reallocation is autonomous, raising the ceiling is the CEO's call):", ...lines].join("\n");
}

/** Render the pending recommendation queue inside the prompt — what the engines want to open. */
function renderPendingRecommendations(rows: IterationRecommendationSummary[]): string {
  if (!rows.length) return "iteration_recommendations (status=pending): (none — no open recommendations on the queue)";
  const lines = rows.map(
    (r) => `  - [${r.action_type}${r.persona ? ` · ${r.persona}` : ""}] ${r.title ?? "(no title)"}${r.rationale ? ` — ${r.rationale.slice(0, 200)}` : ""}`,
  );
  return ["iteration_recommendations (status=pending, newest first):", ...lines].join("\n");
}

/** Render proposed voice-mined angles tied to `approve_voice_angle` actions — hook + voice density + score. */
function renderProposedVoiceAngles(rows: ProposedVoiceAngleSummary[]): string {
  if (!rows.length) return "";
  const lines = rows.map((r) => {
    const counts = r.source_signal_counts;
    const cited = counts.positive + counts.objection + counts.use_case;
    const score = r.score != null ? r.score.toFixed(3) : "?";
    const overlap = r.matrix_overlap != null ? r.matrix_overlap.toFixed(2) : "?";
    const density = r.density != null ? r.density.toFixed(2) : "?";
    return `  - angle ${r.id.slice(0, 8)} · product ${r.product_id.slice(0, 8)} · score=${score} (overlap=${overlap}, density=${density}) · cited ${cited} fragments (${counts.positive}p/${counts.objection}o/${counts.use_case}u)${r.hook_one_liner ? `\n      hook: "${r.hook_one_liner.slice(0, 160)}"` : ""}${r.mechanism_claim ? `\n      mechanism: "${r.mechanism_claim.slice(0, 160)}"` : ""}`;
  });
  return [
    "proposed product_ad_angles (voice-mined candidates targeted by this request — cited customer language is the ANCHOR; an angle that cites 0 fragments is unanchored and you must escalate it):",
    ...lines,
  ].join("\n");
}

/** Render the latest iteration_runs row — the supervisability record the Director MUST see. */
function renderLatestIterationRun(run: IterationRunSummary | null): string {
  if (!run) return "iteration_runs: (no runs yet — the daily pipeline has never executed for this workspace)";
  const counts = run.counts && Object.keys(run.counts).length ? JSON.stringify(run.counts) : "(none)";
  return [
    "iteration_runs (latest, newest first):",
    `  - id=${run.id.slice(0, 8)} · status=${run.status} · day=${run.snapshot_date ?? "?"} · policy_active=${run.policy_active}${run.policy_version_id ? ` · policy=${run.policy_version_id.slice(0, 8)}` : ""}`,
    `  - started ${run.started_at ?? "?"}${run.finished_at ? ` · finished ${run.finished_at}` : ""}${run.duration_ms != null ? ` · ${run.duration_ms}ms` : ""}`,
    `  - counts: ${counts}`,
    run.error ? `  - error: ${run.error.slice(0, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Render the iteration_actions outcomes for the latest run — the realized executed/failed/reversed/
 * escalated mix the Director needs to see before approving the next policy version. ROAS line is
 * summary stats so the prompt stays compact.
 */
function renderIterationActionOutcomes(rows: IterationActionOutcomeSummary[]): string {
  if (!rows.length) {
    return "iteration_actions (latest run): (no actions decided on the latest run's snapshot — engine is in observation-only mode or no triggers fired)";
  }
  const byStatus = new Map<string, number>();
  const guardrails = new Map<string, number>();
  const roasSeen: number[] = [];
  for (const a of rows) {
    byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
    if (a.guardrail) guardrails.set(a.guardrail, (guardrails.get(a.guardrail) ?? 0) + 1);
    if (typeof a.outcome_roas === "number" && Number.isFinite(a.outcome_roas)) roasSeen.push(a.outcome_roas);
  }
  const statusLine = Array.from(byStatus.entries())
    .map(([s, n]) => `${s}=${n}`)
    .join(", ");
  const guardrailLine = guardrails.size
    ? `  guardrails fired: ${Array.from(guardrails.entries()).map(([g, n]) => `${g}=${n}`).join(", ")}`
    : "";
  const roasLine = roasSeen.length
    ? `  realized outcome_roas: mean ${(roasSeen.reduce((a, b) => a + b, 0) / roasSeen.length).toFixed(2)} across ${roasSeen.length} reconciled action(s) (min ${Math.min(...roasSeen).toFixed(2)}, max ${Math.max(...roasSeen).toFixed(2)})`
    : "  realized outcome_roas: (not yet reconciled for this run's actions — reconcilePriorActions runs after the maturation window)";
  return [
    `iteration_actions (latest run · ${rows.length} action${rows.length === 1 ? "" : "s"}):`,
    `  status mix: ${statusLine}`,
    guardrailLine,
    roasLine,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The Max `claude -p` investigation prompt — read-only diagnose → one JSON verdict.
 *
 * Wrapped with `directorLiveStateFact(admin,'growth')` (the same DB row the runtime guards gate on)
 * so the verdict is premised on the LIVE flag, never on a stale brain page that still narrates
 * "dormant" or "not yet live" (brain-platform-live-autonomous-status Phase 2 — the recurrence guard
 * applied to Growth). The verdict is binary `auto-approve|escalate` — Growth's pending-action types
 * are policy/budget/creative flips that either pass the soundness gate (auto-approve) or don't
 * (escalate); there is no `bounce` lane (that is Platform's repair-spec quality-bounce).
 */
export async function growthDirectorInvestigationPrompt(admin: Admin, brief: GrowthDirectorBrief): Promise<string> {
  const liveState = await directorLiveStateFact(admin, GROWTH);

  const actionBlock = brief.actions
    .map((a, i) => {
      const head = brief.multi
        ? `Action ${i + 1} — category=${a.category}:`
        : `This request — category=${a.category}, kind=${brief.kind}, spec=${brief.specSlug ?? "—"}:`;
      return [
        head,
        `  summary: ${a.summary}`,
        a.preview ? `  proposed fix / preview:\n${a.preview}` : "",
        a.cmd ? `  command that runs on approval: ${a.cmd}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const bundleRule = brief.multi
    ? [
        `This Approval Request BUNDLES ${brief.actions.length} actions that run together (kind=${brief.kind}, spec=${brief.specSlug ?? "—"}) — e.g. activate an iteration policy version + flip the storefront optimizer policy as one atomic approval.`,
        "Decide ALL-OR-NOTHING: AUTO-APPROVE only if EVERY action is sound + within the leash AND the bundle is REVERSIBLE as a whole. If ANY single action is destructive, irreversible, out of leash, or unconfirmable, ESCALATE the WHOLE request. Never partial-approve.",
      ].join("\n")
    : "Investigate the cause + the proposed action and decide.";

  return [
    liveState,
    "",
    "You are the Growth Director for ShopCX, running on Max (read-only prod DB + the brain, no API key).",
    "A growth tool you supervise (the storefront optimizer, the ad engine, Meta creative adapter, or the ad-spend rail)",
    "raised an Approval Request that routed to YOU. Your job: investigate READ-ONLY, then decide — AUTO-APPROVE only",
    "if it is SOUND, LOW-RISK, and WITHIN THE LEASH; otherwise ESCALATE to the CEO. NEVER rubber-stamp: if you",
    "cannot confirm it is sound and in-leash, escalate.",
    "",
    "The leash — you MAY auto-approve ONLY these classes:",
    "- iteration_policy_activation: authoring/activating a versioned iteration_policies row — a typed,",
    "  reversible policy edit (activation supersedes the prior `active` row; the engine reads it read-only).",
    "- storefront_optimizer_policy_activation: flipping `storefront_optimizer_policy.active` for an allowlisted",
    "  product — a reversible on/off the next pass re-reads.",
    "- pause_underperforming_creative: a Meta creative status flip via the existing iteration_actions `pause`",
    "  adapter — reversible (the same adapter unpauses).",
    "- reallocate_within_ceiling: a budget reallocation that stays WITHIN an active ad_spend_budgets ceiling",
    "  (no ceiling-breaking deltas; the active ceiling is the hard rail).",
    "- promote_ready_to_test_creative: approving a creative INTO the ad_publish_jobs PAUSED flow (the publisher",
    "  writes meta ids back PAUSED — never goes live without a second approve).",
    "- approve_voice_angle: approving a voice-mined product_ad_angle (status='proposed') — flips the angle row",
    "  to status='approved' + is_active=true, inserts an ad_campaigns row tagged to it, and enqueues a",
    "  static-request via the makers pipeline. The new creative lands on the ready-to-test queue PAUSED;",
    "  a second approval is still required to flip it live. ANCHORING IS NON-NEGOTIABLE — an angle whose",
    "  metadata.mined_from contains 0 real review/cancel/ticket ids is unanchored and you MUST escalate it.",
    "",
    "ALWAYS ESCALATE (never auto-approve): anything destructive or irreversible, a budget ceiling change /",
    "ceiling-breaking spend delta, a non-binary CHOICE action, modifying or abandoning an approved goal,",
    "starting a NEW goal, or anything you cannot confirm is sound.",
    "",
    bundleRule,
    "",
    "## Current Growth control surfaces (loaded read-only into the brief)",
    `workspace_id: ${brief.workspaceId}`,
    `function_autonomy('growth'): ${brief.growthAutonomy ? `live=${brief.growthAutonomy.live}, autonomous=${brief.growthAutonomy.autonomous}` : "UNKNOWN (read failed — treat as off)"}`,
    "",
    renderIterationPolicies(brief.iterationPolicies),
    "",
    renderOptimizerPolicy(brief.storefrontOptimizerPolicy),
    "",
    renderAdSpendBudgets(brief.adSpendBudgets),
    "",
    renderLatestIterationRun(brief.latestIterationRun),
    "",
    renderIterationActionOutcomes(brief.iterationActionOutcomes),
    "",
    renderPendingRecommendations(brief.pendingRecommendations),
    brief.proposedVoiceAngles.length ? "\n" + renderProposedVoiceAngles(brief.proposedVoiceAngles) : "",
    "",
    "## The request under investigation",
    actionBlock,
    brief.logTail ? `\ninvestigation log so far:\n${brief.logTail}` : "",
    "",
    "Investigate read-only (the implicated policy version SQL, the optimizer policy row, the recommendation rationale,",
    "the creative/spend lines this touches, and — for approve_voice_angle — the angle's mined_from fragment ids must be",
    "REAL row ids in product_reviews / customer_events / tickets). Confirm every action is sound, reversible, and within",
    "the leash before approving.",
    "",
    "Final message = ONLY one JSON object:",
    '{"verdict":"auto-approve","leash_category":"iteration_policy_activation|storefront_optimizer_policy_activation|pause_underperforming_creative|reallocate_within_ceiling|promote_ready_to_test_creative|approve_voice_angle","reasoning":"<why every action is sound + low-risk + within the leash, and the bundle is reversible>"}',
    '{"verdict":"escalate","reasoning":"<why this needs the CEO — high-stakes / irreversible / unconfirmable / out of leash / a choice / a ceiling change>"}',
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Phase 3 — enqueuer + applyDirectorApproval ───────────────────────────────────────────────────
// Mirrors platform-director's enqueuer + helper. The box worker handler (`runGrowthDirectorJob`,
// scripts/builder-worker.ts) is the other half — it claims the queued job, builds the brief, runs the
// Max investigation, and dispatches the verdict via `applyDirectorApproval` (auto-approve) or the
// reused `escalateApprovalRequestToCeo` (escalate). The supervisable-autonomy ledger row
// (`approval_decisions`, decided_by='director', routed_to_function='growth', autonomous=true) is
// written by `applyDirectorApproval`; the per-decision `director_activity` row
// (director_function='growth', action_kind='approved_approval'|'escalated') is written by the worker.

/** Does an approval raised by `kind` route to the Growth director, given the live chart + flags? */
export function routesToGrowth(kind: string, chart: OrgChartGraph, autonomy: AutonomyMap): boolean {
  return resolveApprover(ownerFunctionForKind(kind), chart, autonomy) === GROWTH;
}

/**
 * Auto-approve a target job — the AUTONOMOUS director path. Mirrors platform-director's helper:
 * mark every listed action `approved`, flip the job to `queued_resume` once no pending actions remain
 * (the execution path is unchanged — the worker resumes the same way the human approve path does),
 * then write the supervisable-autonomy ledger row (decided_by='director', routed_to_function='growth',
 * autonomous=true). A bundle is approved atomically — the leash gate has already verified ALL-OR-NOTHING.
 */
export async function applyDirectorApproval(
  admin: Admin,
  target: DirectorTargetJob,
  actionIds: string | string[],
  reasoning: string,
): Promise<{ ok: boolean; error?: string }> {
  const ids = new Set(Array.isArray(actionIds) ? actionIds : [actionIds]);
  const actions = (target.pending_actions || []).map((a) => (a.id && ids.has(a.id) ? { ...a, status: "approved" } : a));
  const stillPending = actions.some((a) => (a.status ?? "pending") === "pending");
  const patch: Record<string, unknown> = { pending_actions: actions, updated_at: new Date().toISOString() };
  if (!stillPending) patch.status = "queued_resume";
  const { error } = await admin.from("agent_jobs").update(patch).eq("id", target.id);
  if (error) return { ok: false, error: error.message };

  await recordApprovalDecision(admin, {
    workspaceId: target.workspace_id,
    agentJobId: target.id,
    // One ledger row per approval. A single action keeps its id; a bundle keys on the job (the grader
    // reads approval_decision_id, not the action), so pending_action_id is null.
    pendingActionId: ids.size === 1 ? Array.from(ids)[0] : null,
    raisedByFunction: ownerFunctionForKind(target.kind) ?? GROWTH,
    routedToFunction: GROWTH,
    decidedBy: "director",
    decision: "approved",
    reasoning,
    autonomous: true,
  });
  return { ok: true };
}

/**
 * The enqueuer — find every open Growth-routed Approval Request and queue ONE `growth-director` job
 * per target for the box lane to investigate. Idempotent (one director job per target, ever) and a
 * NO-OP while Growth isn't live+autonomous (the dormant-until-M6 state — `resolveApprover` won't pick
 * Growth, so no target ever matches). Best-effort. Mirrors `enqueuePlatformDirectorJobs`.
 */
export async function enqueueGrowthDirectorJobs(admin: Admin): Promise<{ enqueued: number; slugs: string[] }> {
  const autonomy = await loadAutonomyMap();
  if (!growthIsAutoApprover(autonomy)) return { enqueued: 0, slugs: [] }; // dormant until the M6 flag flips
  const chart = await buildOrgChartGraph();

  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, status, pending_actions")
    .eq("status", "needs_approval")
    .limit(200);
  const targets = (jobs || []).filter((j) => routesToGrowth(String(j.kind), chart, autonomy));
  if (!targets.length) return { enqueued: 0, slugs: [] };

  // Dedup: never queue a second director job for a target that already has one (any status). A
  // deferred (escalated) target stays needs_approval, so this is what stops an infinite re-enqueue.
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("instructions")
    .eq("kind", "growth-director")
    .order("created_at", { ascending: false })
    .limit(500);
  const seen = new Set<string>();
  for (const e of existing || []) {
    try {
      const i = JSON.parse((e.instructions as string) || "{}");
      if (i.target_job_id) seen.add(String(i.target_job_id));
    } catch {
      /* not JSON — skip */
    }
  }

  const slugs: string[] = [];
  for (const t of targets) {
    if (seen.has(String(t.id))) continue;
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: t.workspace_id,
      spec_slug: t.spec_slug || String(t.kind),
      kind: "growth-director",
      status: "queued",
      created_by: null,
      instructions: JSON.stringify({ target_job_id: t.id, target_kind: t.kind }),
    });
    if (!error) slugs.push(t.spec_slug || String(t.kind));
  }
  return { enqueued: slugs.length, slugs };
}
