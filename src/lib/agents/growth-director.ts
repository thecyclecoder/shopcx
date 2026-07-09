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
import { recordDirectorActivity } from "@/lib/director-activity";
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

/** One open `storefront-optimizer` agent_jobs row — a proposal in flight the director must see
 *  before approving an optimizer-policy flip (so they can read what the optimizer wants to do
 *  with the on-switch they're about to flip). */
export interface StorefrontOptimizerJobSummary {
  id: string;
  /** The surface key `product:lander:audience` — the agent_jobs.spec_slug. */
  surfaceKey: string;
  status: string;
  pendingActionsCount: number;
  createdAt: string | null;
}

/** One recent storefront_campaign_grades row — the Head-of-Growth grade the director can
 *  override via `gradeDirectorDecision`. The brief carries the per-experiment grade so the
 *  director can grade/un-grade from the mini-report. */
export interface StorefrontCampaignGradeSummary {
  id: string;
  experiment_id: string;
  grade_initial: number | null;
  grade_revised: number | null;
  hypothesis_quality: number | null;
  result_quality: number | null;
  graded_by: string;
  initial_graded_at: string | null;
  revised_graded_at: string | null;
}

/** One in-window storefront_experiments row — the per-campaign mini-report. Carries the
 *  `last_decision.delivery_flag` from growth-storefront-experiment-delivery-verification so the
 *  director can see which campaigns failed to deliver (the Phase-3 gate on promote/kill keys on
 *  exactly this flag). */
export interface StorefrontExperimentSummary {
  id: string;
  product_id: string;
  lander_type: string;
  audience: string;
  lever: string;
  status: string;
  /** Pulled from `last_decision.delivery_flag` (null when the audit hasn't run yet). */
  delivery_flag: string | null;
  started_at: string | null;
  stopped_at: string | null;
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

// ── Media-buyer supervision rollup (media-buyer-grade-rollup-on-growth-director-brief Phase 1) ────
// Surfaces per-cohort Media Buyer grade averages + shadow-vs-review agreement + the latest arming
// authorization onto the Growth Director's brief so Max can supervise the CEO → Growth → Media Buyer
// chain from ONE prompt. The three axes together are the "is the media buyer earning its arming?"
// signal: grade averages tell whether prior actions held up; the shadow-review concur rate tells
// whether the human reviewer agrees with the plan; the arming-gate row tells whether the executor is
// currently authorized to act. All three come from workspace-scoped tables and are best-effort loaded.

export interface MediaBuyerAvgGradeByKind {
  /** The director_activity action_kind (e.g. `media_buyer_promoted_winner`) — the Media Buyer verb. */
  actionKind: string;
  /** Average of overall_grade (1–10) across every graded action of this kind in the window. */
  avgGrade: number;
  /** Count of graded actions in the window. */
  count: number;
}

export interface MediaBuyerDailyAvg {
  /** UTC day (YYYY-MM-DD) — the `graded_at` date bucket. */
  day: string;
  /** Average of overall_grade for every action graded on this day. */
  avgGrade: number;
  /** Count of graded actions on this day. */
  count: number;
}

export interface MediaBuyerShadowAgreement {
  /** How many `media_buyer_shadow_reviews` rows the reviewer submitted in the window. */
  reviewedCount: number;
  /** How many of those reviews carried `verdict='concur'`. */
  concurCount: number;
  /** `concurCount / reviewedCount` when the sample is > 0; NULL when the window is empty. */
  concurRate: number | null;
}

export interface MediaBuyerArmingAuthorizationSummary {
  id: string;
  /** NULL = workspace-wide row; non-null = per-account row (mirrors the arming-gate axes). */
  metaAdAccountId: string | null;
  /** ISO 8601 week label (`YYYY-Www`). */
  isoWeek: string;
  allowed: boolean;
  /** The structured `{ reasons: [...], metrics: {...} }` payload as stored — the audit truth. */
  reasons: unknown;
  evaluatedAt: string;
  expiresAt: string;
}

export interface MediaBuyerRollupSummary {
  /** 30-day average `overall_grade` grouped by `media_buyer_action_grades.action_kind`. */
  avgGradeByKind: MediaBuyerAvgGradeByKind[];
  /** 14-day daily average `overall_grade` across every Media Buyer action, oldest first. */
  dailyOverallAvg14d: MediaBuyerDailyAvg[];
  /** 14-day concur-rate on `media_buyer_shadow_reviews` — the human-in-the-loop agreement signal. */
  shadowAgreement: MediaBuyerShadowAgreement;
  /** The newest `media_buyer_arming_authorization` row for the workspace (null when none exist). */
  latestArmingAuthorization: MediaBuyerArmingAuthorizationSummary | null;
}

/** How many recent grade rows the rollup pulls — bounded so a busy workspace never bloats the brief. */
const MEDIA_BUYER_GRADES_CAP = 500;
/** How many recent shadow reviews the rollup pulls (14-day window; ~10 actions/pass × 14 days is fine). */
const MEDIA_BUYER_SHADOW_REVIEWS_CAP = 1000;
/** Rolling windows (days) — 30d for the by-kind roll-up + 14d for the sparkline + shadow agreement. */
const MEDIA_BUYER_GRADES_WINDOW_DAYS = 30;
const MEDIA_BUYER_DAILY_WINDOW_DAYS = 14;
const MEDIA_BUYER_SHADOW_WINDOW_DAYS = 14;

/**
 * Load the Media Buyer supervision rollup for one workspace — a merge of three cheap reads:
 *   1. `media_buyer_action_grades` last 30 days — grouped in-memory by `action_kind` for the per-verb
 *      avg + a separate 14-day slice for the daily sparkline (single fetch, two windows derived).
 *   2. `media_buyer_shadow_reviews` last 14 days — concur-rate over reviewed count.
 *   3. `media_buyer_arming_authorization` newest row — the current authoritative arming verdict.
 *
 * Returns NULL when every source is empty (no grades, no reviews, no arming row) — this is the
 * verification's expected shape for a workspace with zero grades yet, so the prompt omits the whole
 * section instead of rendering an empty header. Every read is best-effort; a transient failure lands
 * an empty subresult, never a throw.
 *
 * `now` is injectable for tests; production always uses `new Date()`.
 */
export async function loadMediaBuyerRollup(
  admin: Admin,
  workspaceId: string,
  opts: { now?: Date } = {},
): Promise<MediaBuyerRollupSummary | null> {
  const now = opts.now ?? new Date();
  const grades30dSinceIso = new Date(now.getTime() - MEDIA_BUYER_GRADES_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const daily14dCutoffIso = new Date(now.getTime() - MEDIA_BUYER_DAILY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const shadow14dSinceIso = new Date(now.getTime() - MEDIA_BUYER_SHADOW_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // ── (a) 30-day grade sample, once — the 14-day daily slice is derived from it in-memory ───
  let gradeRows: Array<{ action_kind: string; overall_grade: number; graded_at: string }> = [];
  try {
    const { data } = await admin
      .from("media_buyer_action_grades")
      .select("action_kind, overall_grade, graded_at")
      .eq("workspace_id", workspaceId)
      .gte("graded_at", grades30dSinceIso)
      .order("graded_at", { ascending: false })
      .limit(MEDIA_BUYER_GRADES_CAP);
    gradeRows = ((data || []) as Array<{ action_kind: string; overall_grade: number | string; graded_at: string }>).map((r) => ({
      action_kind: r.action_kind,
      overall_grade: Number(r.overall_grade),
      graded_at: r.graded_at,
    }));
  } catch {
    /* best-effort — subresult falls back to empty */
  }

  const kindMap = new Map<string, { total: number; count: number }>();
  for (const r of gradeRows) {
    if (!Number.isFinite(r.overall_grade)) continue;
    const acc = kindMap.get(r.action_kind) ?? { total: 0, count: 0 };
    acc.total += r.overall_grade;
    acc.count += 1;
    kindMap.set(r.action_kind, acc);
  }
  const avgGradeByKind: MediaBuyerAvgGradeByKind[] = Array.from(kindMap.entries())
    .map(([actionKind, v]) => ({ actionKind, avgGrade: v.total / v.count, count: v.count }))
    .sort((a, b) => a.actionKind.localeCompare(b.actionKind));

  const dayMap = new Map<string, { total: number; count: number }>();
  for (const r of gradeRows) {
    if (!Number.isFinite(r.overall_grade)) continue;
    if (r.graded_at < daily14dCutoffIso) continue;
    const day = r.graded_at.slice(0, 10);
    const acc = dayMap.get(day) ?? { total: 0, count: 0 };
    acc.total += r.overall_grade;
    acc.count += 1;
    dayMap.set(day, acc);
  }
  const dailyOverallAvg14d: MediaBuyerDailyAvg[] = Array.from(dayMap.entries())
    .map(([day, v]) => ({ day, avgGrade: v.total / v.count, count: v.count }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // ── (b) 14-day shadow review concur-rate ───────────────────────────────────────────────────
  let reviewedCount = 0;
  let concurCount = 0;
  try {
    const { data } = await admin
      .from("media_buyer_shadow_reviews")
      .select("verdict, reviewed_at")
      .eq("workspace_id", workspaceId)
      .gte("reviewed_at", shadow14dSinceIso)
      .limit(MEDIA_BUYER_SHADOW_REVIEWS_CAP);
    const rows = (data || []) as Array<{ verdict: string; reviewed_at: string }>;
    reviewedCount = rows.length;
    concurCount = rows.filter((r) => r.verdict === "concur").length;
  } catch {
    /* best-effort */
  }
  const shadowAgreement: MediaBuyerShadowAgreement = {
    reviewedCount,
    concurCount,
    concurRate: reviewedCount > 0 ? concurCount / reviewedCount : null,
  };

  // ── (c) latest arming authorization row ────────────────────────────────────────────────────
  let latestArmingAuthorization: MediaBuyerArmingAuthorizationSummary | null = null;
  try {
    const { data } = await admin
      .from("media_buyer_arming_authorization")
      .select("id, meta_ad_account_id, iso_week, allowed, reasons, evaluated_at, expires_at")
      .eq("workspace_id", workspaceId)
      .order("evaluated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      latestArmingAuthorization = {
        id: data.id as string,
        metaAdAccountId: (data.meta_ad_account_id as string | null) ?? null,
        isoWeek: data.iso_week as string,
        allowed: !!data.allowed,
        reasons: data.reasons ?? null,
        evaluatedAt: data.evaluated_at as string,
        expiresAt: data.expires_at as string,
      };
    }
  } catch {
    /* best-effort */
  }

  // Verification: on a workspace with zero grades yet → rollup is null so the prompt omits the
  // whole "Media Buyer supervision" section instead of rendering an empty header. "Nothing to show"
  // means no graded actions, no shadow reviews, AND no arming authorization row — any one of those
  // is enough to include the section.
  if (
    avgGradeByKind.length === 0 &&
    dailyOverallAvg14d.length === 0 &&
    reviewedCount === 0 &&
    latestArmingAuthorization === null
  ) {
    return null;
  }

  return {
    avgGradeByKind,
    dailyOverallAvg14d,
    shadowAgreement,
    latestArmingAuthorization,
  };
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
  /** the open `kind='storefront-optimizer'` agent_jobs rows for the workspace — proposals in flight. */
  openOptimizerJobs: StorefrontOptimizerJobSummary[];
  /** the recent storefront_campaign_grades rows for the workspace (newest first) — what the
   *  director can grade/un-grade via `gradeDirectorDecision`. */
  recentCampaignGrades: StorefrontCampaignGradeSummary[];
  /** the recent storefront_experiments rows for the workspace (newest first) — the per-campaign
   *  mini-report carrying the `last_decision.delivery_flag` (the Phase-3 gate on promote/kill). */
  recentExperiments: StorefrontExperimentSummary[];
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
  /** the Media Buyer supervision rollup (30d avg grade by verb + 14d sparkline + 14d shadow-vs-review
   * agreement + latest arming authorization). NULL when a workspace has zero graded actions AND zero
   * reviewed shadow actions AND no arming authorization row — the prompt then omits the whole section
   * (media-buyer-grade-rollup-on-growth-director-brief Phase 1). */
  mediaBuyerRollup: MediaBuyerRollupSummary | null;
  logTail: string;
}

/** How many iteration_policies versions + pending recommendations the brief carries — cap the prompt size. */
const POLICY_VERSIONS_CAP = 8;
const PENDING_RECOS_CAP = 25;
/** How many recent grades + experiments the brief carries — cap the prompt size. */
const RECENT_GRADES_CAP = 15;
const RECENT_EXPERIMENTS_CAP = 15;
/** How many open `storefront-optimizer` agent_jobs the brief carries (one proposal per surface). */
const OPEN_OPTIMIZER_JOBS_CAP = 25;
/** The agent_jobs.status values that count as "open" — i.e. a proposal still in flight (any
 *  non-terminal status). Mirrors the spirit of `LIVE_OPTIMIZER_STATUSES` in optimizer-agent.ts;
 *  duplicated here to keep `growth-director.ts` free of a transitive dependency on the
 *  optimizer-agent module (which pulls in Nano-Banana / Gemini code paths the director never
 *  touches). The list errs on the side of inclusion — a status the optimizer adds later still
 *  surfaces until it terminalizes. */
const OPEN_OPTIMIZER_JOB_STATUSES = [
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
  "blocked_on_usage",
];
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

  // The open `kind='storefront-optimizer'` agent_jobs — proposals in flight on each surface. The
  // director needs to see WHICH surfaces have live optimizer activity before approving a policy
  // flip (a flip on `active` immediately starts churning those surfaces; surfacing them lets the
  // director catch a flip that would race a still-resolving proposal).
  let openOptimizerJobs: StorefrontOptimizerJobSummary[] = [];
  try {
    const { data } = await admin
      .from("agent_jobs")
      .select("id, spec_slug, status, pending_actions, created_at")
      .eq("workspace_id", job.workspace_id)
      .eq("kind", "storefront-optimizer")
      .in("status", OPEN_OPTIMIZER_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(OPEN_OPTIMIZER_JOBS_CAP);
    openOptimizerJobs = ((data || []) as { id: string; spec_slug: string | null; status: string; pending_actions: unknown; created_at: string | null }[]).map((r) => ({
      id: r.id,
      surfaceKey: r.spec_slug ?? "(no surface key)",
      status: r.status,
      pendingActionsCount: Array.isArray(r.pending_actions) ? (r.pending_actions as unknown[]).length : 0,
      createdAt: r.created_at ?? null,
    }));
  } catch {
    /* best-effort */
  }

  // The recent storefront_campaign_grades — the Head-of-Growth grade per concluded campaign.
  // Surfaces both axes (initial + revised) + the human-override flag so the director can decide
  // whether to grade/un-grade via `gradeDirectorDecision`.
  let recentCampaignGrades: StorefrontCampaignGradeSummary[] = [];
  try {
    const { data } = await admin
      .from("storefront_campaign_grades")
      .select("id, experiment_id, grade_initial, grade_revised, hypothesis_quality, result_quality, graded_by, initial_graded_at, revised_graded_at")
      .eq("workspace_id", job.workspace_id)
      .order("updated_at", { ascending: false })
      .limit(RECENT_GRADES_CAP);
    recentCampaignGrades = ((data || []) as StorefrontCampaignGradeSummary[]).map((r) => ({
      id: r.id,
      experiment_id: r.experiment_id,
      grade_initial: r.grade_initial ?? null,
      grade_revised: r.grade_revised ?? null,
      hypothesis_quality: r.hypothesis_quality ?? null,
      result_quality: r.result_quality ?? null,
      graded_by: r.graded_by ?? "agent",
      initial_graded_at: r.initial_graded_at ?? null,
      revised_graded_at: r.revised_graded_at ?? null,
    }));
  } catch {
    /* best-effort */
  }

  // The recent storefront_experiments — the per-campaign mini-report. `last_decision.delivery_flag`
  // is pulled out for the prompt (the Phase-3 gate on promote/kill keys on this exact value).
  let recentExperiments: StorefrontExperimentSummary[] = [];
  try {
    const { data } = await admin
      .from("storefront_experiments")
      .select("id, product_id, lander_type, audience, lever, status, last_decision, started_at, stopped_at")
      .eq("workspace_id", job.workspace_id)
      .order("updated_at", { ascending: false })
      .limit(RECENT_EXPERIMENTS_CAP);
    recentExperiments = ((data || []) as { id: string; product_id: string; lander_type: string; audience: string; lever: string; status: string; last_decision: Record<string, unknown> | null; started_at: string | null; stopped_at: string | null }[]).map((r) => {
      const decisionFlag = r.last_decision && typeof r.last_decision === "object" ? (r.last_decision as Record<string, unknown>)["delivery_flag"] : null;
      return {
        id: r.id,
        product_id: r.product_id,
        lander_type: r.lander_type,
        audience: r.audience,
        lever: r.lever,
        status: r.status,
        delivery_flag: typeof decisionFlag === "string" ? decisionFlag : null,
        started_at: r.started_at ?? null,
        stopped_at: r.stopped_at ?? null,
      };
    });
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

  // Media Buyer supervision rollup — best-effort; NULL when the workspace has no graded actions,
  // no shadow reviews, and no arming authorization row (verification: prompt omits the section then).
  let mediaBuyerRollup: MediaBuyerRollupSummary | null = null;
  try {
    mediaBuyerRollup = await loadMediaBuyerRollup(admin, job.workspace_id);
  } catch {
    /* best-effort — the loader itself is defensive, but keep the catch as belt-and-suspenders */
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
    openOptimizerJobs,
    recentCampaignGrades,
    recentExperiments,
    latestIterationRun,
    iterationActionOutcomes,
    adSpendBudgets,
    proposedVoiceAngles,
    mediaBuyerRollup,
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

/** Render the open storefront-optimizer agent_jobs — proposals in flight per surface. */
function renderOptimizerJobs(rows: StorefrontOptimizerJobSummary[]): string {
  if (!rows.length) return "storefront-optimizer agent_jobs (open): (none — no proposals in flight)";
  const lines = rows.map(
    (r) => `  - surface=${r.surfaceKey} · status=${r.status} · pending_actions=${r.pendingActionsCount}${r.createdAt ? ` · created ${r.createdAt}` : ""}`,
  );
  return ["storefront-optimizer agent_jobs (open, newest first):", ...lines].join("\n");
}

/** Render the recent storefront_campaign_grades — initial + revised + override flag. */
function renderCampaignGrades(rows: StorefrontCampaignGradeSummary[]): string {
  if (!rows.length) return "storefront_campaign_grades (recent): (none — no campaigns graded yet)";
  const lines = rows.map((r) => {
    const init = r.grade_initial != null ? `${r.grade_initial}/10` : "—";
    const rev = r.grade_revised != null ? `${r.grade_revised}/10` : "—";
    const sub = r.hypothesis_quality != null || r.result_quality != null
      ? ` · hypothesis=${r.hypothesis_quality ?? "—"} · result=${r.result_quality ?? "—"}`
      : "";
    return `  - exp=${r.experiment_id} · initial=${init} · revised=${rev}${sub} · graded_by=${r.graded_by}`;
  });
  return ["storefront_campaign_grades (recent, newest first):", ...lines].join("\n");
}

/** Render the in-window storefront_experiments — per-campaign mini-report with delivery flag.
 *  This is the surface the director grades/un-grades over via `gradeDirectorDecision`. */
function renderExperimentsMiniReport(rows: StorefrontExperimentSummary[]): string {
  if (!rows.length) return "storefront_experiments (recent): (none — no in-window experiments)";
  const lines = rows.map((r) => {
    const flag = r.delivery_flag ? ` · delivery_flag=${r.delivery_flag}` : "";
    return `  - exp=${r.id} · product=${r.product_id} · lander=${r.lander_type}/${r.audience} · lever=${r.lever} · status=${r.status}${flag}${r.started_at ? ` · started ${r.started_at}` : ""}${r.stopped_at ? ` · stopped ${r.stopped_at}` : ""}`;
  });
  return [
    "storefront_experiments (recent, newest first) — the per-campaign mini-report:",
    "  (a `delivery_flag='failed_to_deliver'` means the audit found the variant didn't actually reach shoppers — blocks promote/kill until verified.)",
    ...lines,
  ].join("\n");
}

/**
 * Render the Media Buyer supervision rollup — the CEO → Growth → Media Buyer chain visibility
 * (media-buyer-grade-rollup-on-growth-director-brief Phase 1). Returns an EMPTY string when the
 * rollup is null so the caller (growthDirectorInvestigationPrompt) can omit the whole section
 * rather than render a bare header — the verification's expected shape for a zero-grades workspace.
 */
function renderMediaBuyerRollup(r: MediaBuyerRollupSummary | null): string {
  if (!r) return "";
  const lines: string[] = ["## Media Buyer supervision"];

  // Per-verb roll-up (30d).
  if (r.avgGradeByKind.length) {
    lines.push("avg grade by action_kind (last 30d):");
    for (const k of r.avgGradeByKind) {
      lines.push(`  - ${k.actionKind}: ${k.avgGrade.toFixed(2)}/10 (${k.count} action${k.count === 1 ? "" : "s"})`);
    }
  } else {
    lines.push("avg grade by action_kind (last 30d): (no graded Media Buyer actions in window)");
  }

  // Daily sparkline (14d) — compact one-line summary keeps prompt tokens sane.
  if (r.dailyOverallAvg14d.length) {
    const summary = r.dailyOverallAvg14d.map((d) => `${d.day}=${d.avgGrade.toFixed(1)}`).join(", ");
    lines.push(`daily overall avg grade (last 14d): ${summary}`);
  } else {
    lines.push("daily overall avg grade (last 14d): (no graded Media Buyer actions in window)");
  }

  // Shadow agreement (14d) — the human-in-the-loop concur signal (input to the arming precondition).
  if (r.shadowAgreement.reviewedCount > 0) {
    const pct = ((r.shadowAgreement.concurRate ?? 0) * 100).toFixed(1);
    lines.push(
      `shadow-vs-review agreement (last 14d): ${pct}% (${r.shadowAgreement.concurCount}/${r.shadowAgreement.reviewedCount} concur)`,
    );
  } else {
    lines.push("shadow-vs-review agreement (last 14d): (no reviewed shadow actions in window)");
  }

  // Latest arming authorization — the current authoritative "can the executor act?" verdict.
  if (r.latestArmingAuthorization) {
    const a = r.latestArmingAuthorization;
    const scope = a.metaAdAccountId ? `account ${a.metaAdAccountId.slice(0, 8)}` : "workspace-wide";
    lines.push(
      `latest arming authorization: iso_week=${a.isoWeek} · ${scope} · allowed=${a.allowed} · evaluated ${a.evaluatedAt} · expires ${a.expiresAt}`,
    );
  } else {
    lines.push("latest arming authorization: (none — Media Buyer arming gate has never run for this workspace)");
  }

  return lines.join("\n");
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
    renderOptimizerJobs(brief.openOptimizerJobs),
    "",
    renderCampaignGrades(brief.recentCampaignGrades),
    "",
    renderExperimentsMiniReport(brief.recentExperiments),
    "",
    renderAdSpendBudgets(brief.adSpendBudgets),
    "",
    renderLatestIterationRun(brief.latestIterationRun),
    "",
    renderIterationActionOutcomes(brief.iterationActionOutcomes),
    "",
    renderPendingRecommendations(brief.pendingRecommendations),
    brief.proposedVoiceAngles.length ? "\n" + renderProposedVoiceAngles(brief.proposedVoiceAngles) : "",
    // media-buyer-grade-rollup-on-growth-director-brief Phase 1: surface the Media Buyer supervision
    // signals iff the rollup is present. An empty rollup (no grades, no reviews, no arming row)
    // returns null → the whole section is omitted (verification: prompt omits rather than renders an
    // empty header).
    brief.mediaBuyerRollup ? "\n" + renderMediaBuyerRollup(brief.mediaBuyerRollup) : "",
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

// ── Phase 2 — director grading on the per-campaign mini-report ───────────────────────────────────
// The brief surfaces a per-campaign mini-report (status + delivery_flag + current grade); this is the
// write the Growth director uses to grade/un-grade one of those campaigns. Mirrors the dashboard
// override route (src/app/api/workspaces/[id]/storefront-campaign-grades/[gradeId]/route.ts):
// updates the chosen axis (initial / revised), stamps graded_by='human' + the overrider + the reason,
// and writes one `director_activity` row (`action_kind='graded_optimizer_campaign'`). The autonomous
// audit trail the spec's prod verification queries.
//
// `axis: 'clear'` is the un-grade — drops the chosen axis (initial OR revised) back to NULL so the
// next agent grading pass writes a fresh grade. Used when the override itself was wrong (the director
// re-considers and resets to let the agent's grade stand). The director_activity row records the
// un-grade with `metadata.action='cleared'` so the audit trail keeps the override + reset pair.

export interface GradeDirectorDecisionInput {
  workspaceId: string;
  /** The storefront_experiments.id whose campaign is being graded — the lookup key on the grade row. */
  experimentId: string;
  /** Which grade axis the director is grading. `'initial'` = the proxy-time grade, `'revised'` = the
   *  ~4-month actual-LTV grade. */
  axis: "initial" | "revised";
  /** A 1–10 grade, OR `null` to CLEAR the override (un-grade the axis back to NULL). */
  grade: number | null;
  /** The Director's WHY — surfaced on the audit row + the override_reason column. */
  reasoning: string;
  /** auth.users.id of the human/agent the Director acts on behalf of (stamped onto `overridden_by`). */
  decidedBy?: string | null;
}

export interface GradeDirectorDecisionResult {
  ok: boolean;
  /** The storefront_campaign_grades.id that was written (when found). */
  gradeId?: string;
  /** Whether the axis was cleared (un-grade) — true for grade=null, false for an override. */
  cleared?: boolean;
  detail: string;
}

/**
 * The Growth director's grade/un-grade write on the per-campaign mini-report. Writes:
 *   1. storefront_campaign_grades update — the chosen axis grade + override_reason + graded_by='human'
 *      + overridden_by + overridden_at. The OTHER axis is left untouched (both grades always persist).
 *      For `grade=null` (un-grade) the chosen axis is reset to NULL with graded_by='agent' so the
 *      next agent pass writes a fresh grade.
 *   2. director_activity row — `action_kind='graded_optimizer_campaign'`, carrying the experiment_id
 *      + axis + the prior + new grade + the reasoning + decidedBy. The audit trail the spec's prod
 *      verification queries; ≥1 row per concluded campaign is the expected post-merge state.
 *
 * Best-effort + typed result (no throws) — mirrors `authorOptimizerPolicy` /
 * `activateOptimizerPolicy`. A grade row missing for the experiment_id fails fast (the director
 * cannot grade what hasn't been graded yet — the agent grades first at significance, then the
 * director overrides).
 */
export async function gradeDirectorDecision(
  admin: Admin,
  input: GradeDirectorDecisionInput,
): Promise<GradeDirectorDecisionResult> {
  if (!input.workspaceId) return { ok: false, detail: "gradeDirectorDecision: workspaceId required" };
  if (!input.experimentId) return { ok: false, detail: "gradeDirectorDecision: experimentId required" };
  if (input.axis !== "initial" && input.axis !== "revised") {
    return { ok: false, detail: `gradeDirectorDecision: axis must be 'initial' or 'revised' (got ${input.axis})` };
  }
  const grade = input.grade;
  const cleared = grade === null;
  if (!cleared) {
    if (!Number.isInteger(grade) || (grade as number) < 1 || (grade as number) > 10) {
      return { ok: false, detail: "gradeDirectorDecision: grade must be 1–10 or null (to clear)" };
    }
  }
  const reason = (input.reasoning || "").trim();
  if (!reason) return { ok: false, detail: "gradeDirectorDecision: reasoning required" };

  // Load the grade row by experiment_id (UNIQUE — one grade row per campaign).
  const { data: existing, error: loadErr } = await admin
    .from("storefront_campaign_grades")
    .select("id, grade_initial, grade_revised, graded_by")
    .eq("workspace_id", input.workspaceId)
    .eq("experiment_id", input.experimentId)
    .maybeSingle();
  if (loadErr) return { ok: false, detail: `gradeDirectorDecision load failed: ${loadErr.message}` };
  if (!existing) {
    return {
      ok: false,
      detail: `gradeDirectorDecision: no storefront_campaign_grades row for experiment ${input.experimentId} (the agent must grade at significance first)`,
    };
  }
  const gradeId = (existing as { id: string }).id;
  const priorGrade = input.axis === "revised" ? (existing as { grade_revised: number | null }).grade_revised : (existing as { grade_initial: number | null }).grade_initial;

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now };
  if (cleared) {
    // Un-grade: reset the chosen axis to NULL so the next agent pass writes a fresh grade.
    // graded_by flips back to 'agent' so the agent isn't locked out by the human-override guard.
    if (input.axis === "revised") {
      update.grade_revised = null;
      update.grade_revised_reasoning = null;
      update.revised_graded_at = null;
    } else {
      update.grade_initial = null;
      update.grade_initial_reasoning = null;
      update.initial_graded_at = null;
    }
    update.graded_by = "agent";
    update.overridden_by = null;
    update.override_reason = null;
    update.overridden_at = null;
  } else {
    if (input.axis === "revised") {
      update.grade_revised = grade;
      update.grade_revised_reasoning = `[Growth override] ${reason}`;
    } else {
      update.grade_initial = grade;
      update.grade_initial_reasoning = `[Growth override] ${reason}`;
    }
    update.graded_by = "human";
    update.overridden_by = input.decidedBy ?? null;
    update.override_reason = reason;
    update.overridden_at = now;
  }

  const { error: upErr } = await admin.from("storefront_campaign_grades").update(update).eq("id", gradeId);
  if (upErr) return { ok: false, detail: `gradeDirectorDecision update failed: ${upErr.message}` };

  // One director_activity row — the audit trail the spec's prod verification queries.
  await recordDirectorActivity(admin, {
    workspaceId: input.workspaceId,
    directorFunction: GROWTH,
    actionKind: "graded_optimizer_campaign",
    reason,
    metadata: {
      experiment_id: input.experimentId,
      grade_id: gradeId,
      axis: input.axis,
      prior_grade: priorGrade,
      new_grade: grade,
      cleared,
      decided_by: input.decidedBy ?? null,
      autonomous: true,
    },
  });

  return {
    ok: true,
    gradeId,
    cleared,
    detail: cleared
      ? `cleared ${input.axis} grade on experiment ${input.experimentId}`
      : `set ${input.axis} grade to ${grade} on experiment ${input.experimentId}`,
  };
}
