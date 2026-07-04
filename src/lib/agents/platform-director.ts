/**
 * Platform/DevOps Director agent (platform-director-agent spec, Phase 1) — the FIRST live director.
 *
 * North star (operational-rules § supervisable autonomy): CEO → Director → tool. The Platform tools
 * (repair / db-health / coverage-register / the builder chain) already work; nobody SUPERVISES them
 * as a director. This module is that supervisor's Phase-1 core: investigate every Approval Request
 * routed to Platform and either AUTO-APPROVE it (only when sound + low-risk + within the leash, with
 * the reasoning logged to approval_decisions) or leave it for the CEO. It NEVER rubber-stamps.
 *
 * It does NOT rebuild the tools — it orchestrates the EXISTING approval plumbing:
 *   - approval-router  → who the request routed to (resolveApprover; Platform iff live+autonomous)
 *   - approval-inbox   → which action is a plain inline approve (inlineApproveActionId)
 *   - approval-decisions → the supervisable-autonomy ledger (decided_by='director', autonomous=true)
 *   - director-activity  → the timestamped log the board + recap read (M3)
 *
 * Activation is owner-confirmed and lands in Phase 4: until Platform's function_autonomy flag is
 * flipped `live + autonomous`, resolveApprover never routes anything here, so the enqueuer below is a
 * no-op — the machinery is built but dormant.
 *
 * Phase 2 (escortApprovedGoals, at the bottom) adds the other half of the leash — milestone progression
 * of an ALREADY-APPROVED goal: a proactive sweep that drives the unblocked specs of the goals the
 * director owns through the EXISTING build chain (auto-queue + builder chain + auto-ship + fold), logging
 * each advance. Also dormant until live+autonomous; starting a NEW goal is never auto (Phase 3 escalation).
 *
 * Phase 3 (the loop-guard + CEO escalation, below escortApprovedGoals) closes the leash UP-side: an
 * escalation actually ROUTES to the CEO inbox now (it no longer just sits untouched). Two paths reuse the
 * SAME M2 plumbing (the routed Approval Request notification — the inbox API shows an item to a role iff
 * `metadata.routed_to_function === role`):
 *   - escalateApprovalRequestToCeo — re-routes an out-of-leash / destructive Approval Request the runner
 *     declined to auto-approve to the CEO, carrying the director's written diagnosis inline.
 *   - escortLoopGuard + escalateDiagnosisToCeo — a build that REPEATEDLY fails (≥ the loop-guard cap) is
 *     never re-submitted; the director stops, diagnoses "likely a deeper issue," and surfaces it to the
 *     CEO (a CEO-routed Approval Request + an `escalated` director_activity row), deduped so it pings once.
 *
 * See docs/brain/specs/platform-director-agent.md · docs/brain/libraries/platform-director.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CEO,
  resolveApprover,
  buildOrgChartGraph,
  loadAutonomyMap,
  isAutoApprover,
  type AutonomyMap,
  type OrgChartGraph,
} from "@/lib/agents/approval-router";
import {
  ownerFunctionForKind,
  routingOwnerForJobAsync,
  inlineApproveActionId,
  buildApprovalContent,
  approvalDeepLink,
  activeParkCardExistsForJob,
  type ApprovalJobRow,
} from "@/lib/agents/approval-inbox";
import { recordApprovalDecision } from "@/lib/agents/approval-decisions";
import { setSpecStatus } from "@/lib/specs-table";
import { getOpenRepairs } from "@/lib/repair-agent";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import { getGoal, getGoals, getRoadmap, getRoadmapFilters, getSpec, listArchivedSlugs, type GoalCard, type SpecCard, type SpecStatus } from "@/lib/brain-roadmap";
import { enqueueSpecTestIfDue } from "@/lib/agent-jobs";
import { buildGate } from "@/lib/agents/director-directives";
import { recordDirectorActivity } from "@/lib/director-activity";
import { enqueueRepairJob, parseRepairSpecMeta } from "@/lib/repair-agent";
import {
  enqueueRegressionJob,
  regressionSignature,
  LIVE_REGRESSION_STATUSES,
  REGRESSION_LOOP_GUARD_MAX,
  REGRESSION_RECENT_WINDOW_MS,
  type RegressionInstructions,
} from "@/lib/regression-agent";
import { getHumanTestQueue } from "@/lib/spec-test-runs";
import { markSpecCardForReview, type SpecCardFlags } from "@/lib/spec-card-state";
import { authorSpecRowFromMarkdown } from "@/lib/author-spec";
import {
  driftSuspectPhases,
  isCardFullyShippedWithProvenance,
  phaseHasProvenance,
  branchBuiltCount,
} from "@/lib/spec-phase-provenance";
import { buildControlTowerSnapshot, type LoopColor } from "@/lib/control-tower/monitor";
import { postDirectorMessage } from "@/lib/agents/director-board";
import { getPersona } from "@/lib/agents/personas";
import { classifyMigrationSql } from "@/lib/migration-safety";
import {
  composeRegressionWatchLine,
  composeScorecardWatchLine,
  type Cadence as ScorecardCadence,
  type ScorecardSnapshotLite,
} from "@/lib/agents/platform-scorecard-display";
import type { PostgrestError } from "@supabase/supabase-js";

type Admin = ReturnType<typeof createAdminClient>;

/** The Platform/DevOps director's function slug — the DRI this director embodies. */
export const PLATFORM = "platform";

// ── The leash (the goals/devops-director § leash + operational-rules autonomy rule) ──────────────
// What the director MAY auto-approve. A structural gate (which action class) plus — enforced by the
// runner's read-only investigation — a soundness gate ("never rubber-stamps"). Anything outside this,
// and anything destructive/irreversible/goal-touching, ALWAYS escalates to the CEO.
export type LeashCategory = "error_fix" | "db_health" | "additive_migration" | "monitoring_fix" | "additive_backfill";

export const LEASH_CATEGORIES: LeashCategory[] = ["error_fix", "db_health", "additive_migration", "monitoring_fix", "additive_backfill"];

/**
 * The pending-action types that are UNCONDITIONALLY leash candidates → their leash category. Each must
 * still pass the read-only investigation verdict (the soundness gate). `run_prod_script` is NOT here:
 * a prod script is only in-leash as the dependent backfill of an additive migration in the SAME bundle
 * (the worker-grading P8 multi-action case) — see `categoryFor` / `directorLeashCandidates`.
 *
 * Multi-CHOICE action types (coverage_register register-vs-exempt, storefront_campaign) are deliberately
 * absent — a non-binary CHOICE isn't auto-decided; those still escalate to the CEO.
 */
const LEASH_ACTION_TYPES: Record<string, LeashCategory> = {
  repair_build: "error_fix",
  db_health_build: "db_health",
  apply_migration: "additive_migration",
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

/** True iff Platform is the live + autonomous auto-approver (so requests route here). */
export function platformIsAutoApprover(autonomy: AutonomyMap): boolean {
  return isAutoApprover(PLATFORM, autonomy);
}

/** Does an approval raised by `kind` route to the Platform director, given the live chart + flags? */
export function routesToPlatform(kind: string, chart: OrgChartGraph, autonomy: AutonomyMap): boolean {
  return resolveApprover(ownerFunctionForKind(kind), chart, autonomy) === PLATFORM;
}

/**
 * Job-aware variant (plan-approval-routes-by-goal-owner): for a `plan` job the routing owner is its
 * GOAL's owner (DB read via routingOwnerForJobAsync), NOT the planner's platform default — so Ada's
 * auto-approve sweep never picks up a plan whose goal is owned by another department (it routes to the
 * CEO, or that department's director once live+autonomous). Every other kind resolves exactly as
 * `routesToPlatform` would. Use this wherever an actual job row is in hand.
 */
export async function routesToPlatformForJob(
  admin: Admin,
  job: { kind: string; spec_slug?: string | null; workspace_id?: string; pending_actions?: DirectorActionLike[] | null },
  chart: OrgChartGraph,
  autonomy: AutonomyMap,
): Promise<boolean> {
  const ownerFn = await routingOwnerForJobAsync(admin, job);
  return resolveApprover(ownerFn, chart, autonomy) === PLATFORM;
}

/**
 * Which seat DRIVES a spec's BUILD — the keystone routing for the auto-build lanes (CEO directive
 * 2026-06-29: Ada/Platform is the SOLE builder, for EVERY department, PERMANENTLY).
 *
 * Build-driving is DECOUPLED from the spec's owner and from the org-chart walk. The two authorities are
 * permanently separate:
 *   - BUILD/execution authority = Ada / Platform / DevOps, for ALL specs, ALL departments — she is the
 *     sole CTO/builder. A spec's `owner` is the REQUESTING/OPERATING department (attribution + where the
 *     finished tool's operation lives); it does NOT pick the build driver.
 *   - Department directors (retention, growth, …) OPERATE their own software + AUTHOR specs for the tools
 *     they need. Their `function_autonomy` is OPERATIONAL autonomy, not build-driving. They are the
 *     requester/operator, NEVER the builder.
 *
 * So: whenever Platform is live+autonomous, PLATFORM drives EVERY spec regardless of owner (including a
 * null owner and any named department). A department going live+autonomous does NOT move build-driving off
 * Ada. The ONLY fail-safe: if Platform itself is NOT live+autonomous, build-driving falls through to the
 * CEO (the unchanged dormant behavior — nothing auto-builds until Ada is activated).
 *
 * NOTE: this is the BUILD driver only. `resolveApprover` stays correct for its OTHER (operational, non-build)
 * callers — it still walks the owner's org-chart seat up to the first live+autonomous supervisor. Build-driving
 * no longer rides that walk.
 */
export function specDriver(_owner: string | null | undefined, _chart: OrgChartGraph, autonomy: AutonomyMap): string {
  // Owner-agnostic by design: Ada builds everything. The owner is attribution, not the build driver.
  return platformIsAutoApprover(autonomy) ? PLATFORM : CEO; // fail-safe: Platform dormant ⇒ builds wait on the CEO
}

/** True iff the Platform director (Ada — the sole builder) drives this spec's build. True for ANY owner
 *  whenever Platform is live+autonomous; false (⇒ CEO) ONLY when Platform's own flag is off (fail-safe). */
export function platformDrivesSpec(owner: string | null | undefined, chart: OrgChartGraph, autonomy: AutonomyMap): boolean {
  return specDriver(owner, chart, autonomy) === PLATFORM;
}

/**
 * no-max-on-unreviewed-specs (PRIMARY): true iff a spec has PASSED Vale spec-review and is therefore safe to
 * QUEUE A BUILD for. The same durable signal the claim-time build gate tests (`card.valeReviewPassed`, read
 * off `specs.vale_review_passed_at` — NOT the transient `valePass` Ada's disposition consumes). An already
 * SHIPPED spec is past review by construction. Every Ada build-enqueue lane (the escorts + the init lane) gates
 * on this BEFORE it inserts a `kind:"build"` row — so an `in_review` / never-Vale-passed spec never gets a build
 * job created, and Bo never claims it + burns a Max session on the after-the-fact claim-gate bounce. The
 * claim-time gate stays the backstop; this is the front door that stops the job from ever existing.
 */
export function specReviewDone(card: Pick<SpecCard, "valeReviewPassed" | "status">): boolean {
  return card.valeReviewPassed === true || card.status === "shipped";
}

/**
 * The director's AUTHORITATIVE live-state, rendered as a prompt block — sourced from `public.function_autonomy`
 * (the SAME DB row the lanes' runtime guards gate on), NOT brain prose (brain-platform-live-autonomous-status
 * Phase 2 — the recurrence guard). Every read-only `claude -p` investigation (approval / groom / init /
 * repair-dismissal) carries this so a decision is premised on the LIVE flag, never on a stale 'not yet live /
 * dormant / inert' line that a brain page or spec may still narrate. Includes the dated provenance
 * (`updated_at` / `updated_by`) so the fact is self-evidently DB-keyed. Best-effort + fail-safe: a missing row
 * or read error renders 'UNKNOWN — treat as NOT live+autonomous'.
 */
export async function directorLiveStateFact(admin: Admin, directorFunction: string = PLATFORM): Promise<string> {
  let live = false;
  let autonomous = false;
  let updatedAt: string | null = null;
  let updatedBy: string | null = null;
  let read = false;
  try {
    const { data, error } = await admin
      .from("function_autonomy")
      .select("live, autonomous, updated_at, updated_by")
      .eq("function_slug", directorFunction)
      .maybeSingle();
    if (!error && data) {
      live = !!data.live;
      autonomous = !!data.autonomous;
      updatedAt = (data.updated_at as string | null) ?? null;
      updatedBy = (data.updated_by as string | null) ?? null;
      read = true;
    }
  } catch {
    // best-effort — fall through to the fail-safe 'unknown' state below.
  }
  const provenance = updatedAt ? ` (set ${updatedAt}${updatedBy ? ` by ${updatedBy}` : ""})` : "";
  const state = !read
    ? "UNKNOWN — could not read function_autonomy; treat yourself as NOT live+autonomous (fail-safe)"
    : live && autonomous
      ? `LIVE + AUTONOMOUS${provenance}`
      : `NOT live+autonomous (live=${live}, autonomous=${autonomous})${provenance} — dormant`;
  return [
    "## Your authoritative live-state (from function_autonomy — the runtime guard, NOT brain prose)",
    `The ${directorFunction} director is ${state}.`,
    "This DB row is the SINGLE source of truth for whether you are running autonomously. Decide on THIS fact —",
    "do NOT infer your activation state from any brain page or spec prose (which may lag and say 'dormant',",
    "'not yet live', or 'inert'); if such prose conflicts with this line, this line wins.",
  ].join("\n");
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
 * The leash class for ONE pending action within its bundle, or null (out of leash). Unconditional leash
 * types map via LEASH_ACTION_TYPES. A `run_prod_script` is in-leash ONLY as `additive_backfill` — and only
 * when the SAME bundle also applies an additive migration (the migration-plus-its-dependent-backfill case,
 * worker-grading P8 / the a2edeca0 escalation). A standalone prod script has no migration to anchor it →
 * null → escalate. The soundness gate (the investigation) still confirms the script is an idempotent backfill.
 *
 * Deterministic destructive-SQL rail (destructive-migration-safety-rails Phase 1). BEFORE returning the
 * type-based `additive_migration`/`additive_backfill` for an `apply_migration`/`run_prod_script`, we run
 * `classifyMigrationSql` over the action's cmd+preview. If severity !== 'additive', the action falls OUT
 * of the leash (returns null) — the rail binds Ada, not just the builder; she cannot auto-approve
 * destructive SQL even though the action TYPE is `apply_migration`. The escalation carries the classifier
 * matches so the CEO sees the concrete rail that was hit.
 */
function categoryFor(action: DirectorActionLike, bundle: DirectorActionLike[]): LeashCategory | null {
  const type = action.type;
  if (!type) return null;
  const baseCategory: LeashCategory | null =
    LEASH_ACTION_TYPES[type] ??
    (type === "run_prod_script" && bundle.some((a) => a.type === "apply_migration") ? "additive_backfill" : null);
  if (!baseCategory) return null;
  if (type === "apply_migration" || type === "run_prod_script") {
    const sql = `${action.cmd ?? ""}\n${action.preview ?? ""}`;
    if (classifyMigrationSql(sql).severity !== "additive") return null;
  }
  return baseCategory;
}

/**
 * The leash gate (worker-grading P8 — multi-action). Returns EVERY pending action the director may
 * auto-approve, with its leash class, plus a verdict:
 *   - `none`   — empty, OR ANY pending action is out of leash (multi-choice / non-leash / a destructive type).
 *                A bundle is ALL-OR-NOTHING: one out-of-leash action escalates the whole request.
 *   - `single` — exactly one in-leash action (the original single-inline-approve case).
 *   - `multi`  — a bundle where EVERY action is in-leash (e.g. an additive migration + its idempotent
 *                backfill). Approved atomically; the soundness gate still confirms the bundle is reversible.
 * Replaces the single-action `directorLeashCandidate` (which required exactly one plain action).
 */
export function directorLeashCandidates(job: DirectorTargetJob): { actions: LeashAction[]; verdict: "none" | "single" | "multi" } {
  const pending = pendingTargetActions(job);
  if (!pending.length) return { actions: [], verdict: "none" };
  const actions: LeashAction[] = [];
  for (const a of pending) {
    const category = categoryFor(a, pending);
    if (!category) return { actions: [], verdict: "none" }; // one out-of-leash action ⇒ escalate the whole bundle
    actions.push({ actionId: a.id as string, category });
  }
  return { actions, verdict: actions.length === 1 ? "single" : "multi" };
}

/** Back-compat: the single in-leash action when the request is exactly that, else null. */
export function directorLeashCandidate(job: DirectorTargetJob): LeashAction | null {
  const { actions, verdict } = directorLeashCandidates(job);
  return verdict === "single" ? actions[0] : null;
}

/** One action inside the brief — what the investigation reads to confirm it (and the bundle) is sound. */
export interface DirectorBriefAction {
  category: LeashCategory;
  summary: string;
  preview: string;
  cmd: string;
}

/** The read-only brief the director investigates — the cause + the proposed action(s), inline. */
export interface DirectorBrief {
  jobId: string;
  kind: string;
  specSlug: string | null;
  /** every leash class in the request (one for single, ≥2 for a bundle). */
  categories: LeashCategory[];
  /** each in-leash action's summary/preview/cmd, in bundle order. */
  actions: DirectorBriefAction[];
  /** true when the request bundles >1 action (approved atomically, all-or-nothing). */
  multi: boolean;
  logTail: string;
}

export function buildDirectorBrief(job: DirectorTargetJob, candidates: LeashAction[]): DirectorBrief {
  const actions: DirectorBriefAction[] = candidates.map((c) => {
    const a = (job.pending_actions || []).find((p) => p.id === c.actionId) ?? {};
    return { category: c.category, summary: a.summary || "", preview: a.preview || "", cmd: a.cmd || "" };
  });
  return {
    jobId: job.id,
    kind: job.kind,
    specSlug: job.spec_slug,
    categories: candidates.map((c) => c.category),
    actions,
    multi: actions.length > 1,
    logTail: (job.log_tail || "").slice(-2000),
  };
}

/** The Max `claude -p` investigation prompt — read-only diagnose → one JSON verdict (single or bundle). */
export function directorInvestigationPrompt(brief: DirectorBrief): string {
  const actionBlock = brief.actions
    .map((a, i) => {
      const head = brief.multi ? `Action ${i + 1} — category=${a.category}:` : `This request — category=${a.category}, kind=${brief.kind}, spec=${brief.specSlug ?? "—"}:`;
      return [head, `  summary: ${a.summary}`, a.preview ? `  proposed fix / preview:\n${a.preview}` : "", a.cmd ? `  command that runs on approval: ${a.cmd}` : ""].filter(Boolean).join("\n");
    })
    .join("\n\n");

  const bundleRule = brief.multi
    ? [
        `This Approval Request BUNDLES ${brief.actions.length} actions that run together (kind=${brief.kind}, spec=${brief.specSlug ?? "—"}) — most often an additive migration plus its dependent idempotent backfill.`,
        "Decide ALL-OR-NOTHING: AUTO-APPROVE only if EVERY action is sound + within the leash AND the bundle is REVERSIBLE as a whole. If ANY single action is destructive, irreversible, out of leash, or unconfirmable, ESCALATE the WHOLE request. Never partial-approve.",
        "For an additive_backfill action: confirm the script is an IDEMPOTENT, re-runnable backfill (no destructive writes, safe to re-run) that depends on the additive migration in this same bundle.",
      ].join("\n")
    : "Investigate the cause + the proposed fix and decide.";

  return [
    "You are Ada — the Platform/DevOps Director for ShopCX, running on Max (read-only prod DB + the brain, no API key).",
    "A platform tool you supervise raised an Approval Request that routed to YOU (Platform is live + autonomous).",
    "Your job: investigate the cause + the proposed action(s) READ-ONLY, then decide — AUTO-APPROVE only if it is",
    "SOUND, LOW-RISK, and WITHIN THE LEASH; otherwise ESCALATE to the CEO. NEVER rubber-stamp: if you cannot",
    "confirm it is sound and in-leash, escalate.",
    "",
    "The leash — you MAY auto-approve ONLY these classes:",
    "- error_fix: a repair-agent fix for a real bug — the authored fix spec is sound + scoped.",
    "- db_health: a DB index / health fix — no destructive DDL.",
    "- additive_migration: an ADDITIVE, REVERSIBLE migration (new table/column/index) — NO DROP/DELETE/destructive ALTER/data loss.",
    "- additive_backfill: an IDEMPOTENT, re-runnable backfill script that accompanies an additive migration in the SAME request (never a standalone prod script).",
    "- monitoring_fix: a platform-monitoring registry fix.",
    "ALWAYS ESCALATE (never auto-approve): anything destructive or irreversible (DROP/DELETE/data-dropping),",
    "a non-binary CHOICE (register-vs-exempt / campaign), modifying or abandoning an approved goal, starting a",
    "NEW goal, or anything you cannot confirm is sound.",
    "",
    bundleRule,
    "",
    actionBlock,
    brief.logTail ? `\ninvestigation log so far:\n${brief.logTail}` : "",
    "",
    "Investigate read-only (the implicated spec / the migration SQL / the backfill script / the diagnosed code).",
    "Confirm every action is sound and within the leash before approving.",
    brief.kind === "repair"
      ? "REPAIR target: you SUPERVISE the Repair agent. If the bug is real but the AUTHORED FIX is UNSOUND (broken mechanism, mis-scoped to land, or the code contradicts its premise), choose `bounce` — that sends the fix BACK to the Repair agent with your reasoning to RE-DO its work; it never reaches the CEO. Reserve `escalate` for a call that genuinely needs the CEO (a real out-of-leash/irreversible decision), NOT a fix-quality problem you can hand back. `auto-approve` only a sound fix."
      : "",
    "Final message = ONLY one JSON object:",
    '{"verdict":"auto-approve","leash_category":"error_fix|db_health|additive_migration|additive_backfill|monitoring_fix","reasoning":"<why every action is sound + low-risk + within the leash, and the bundle is reversible>"}',
    brief.kind === "repair"
      ? '{"verdict":"bounce","reasoning":"<the bug is real but the authored fix is unsound — your concrete explanation of WHY, which is handed back to the Repair agent to re-author>"}'
      : "",
    '{"verdict":"escalate","reasoning":"<why this needs the CEO — high-stakes / irreversible / unconfirmable / out of leash / a choice (NOT a repair fix-quality issue — bounce those)>"}',
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Auto-approve a target job — the AUTONOMOUS director path. Mirrors the human approve path
 * (roadmap-actions.approveRoadmapAction) WITHOUT the owner gate: mark the action approved, flip the
 * job to `queued_resume` once no pending actions remain (execution path unchanged — the worker resumes
 * the same way), then log the supervisable-autonomy ledger row (decided_by='director', autonomous=true).
 */
export async function applyDirectorApproval(
  admin: Admin,
  target: DirectorTargetJob,
  actionIds: string | string[],
  reasoning: string,
): Promise<{ ok: boolean; error?: string }> {
  // Multi-action (worker-grading P8): approve EVERY listed action atomically — a bundle is all-or-nothing,
  // so the job flips to queued_resume only once none stay pending (the execution path is unchanged: the
  // worker runs each approved action in order on resume).
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
    // One ledger row per approval. For a single action keep its id; for a bundle the row keys on the job
    // (the grader reads approval_decision_id, not the action), so pending_action_id is null.
    pendingActionId: ids.size === 1 ? Array.from(ids)[0] : null,
    raisedByFunction: ownerFunctionForKind(target.kind) ?? CEO,
    routedToFunction: PLATFORM,
    decidedBy: "director",
    decision: "approved",
    reasoning,
    autonomous: true,
  });
  return { ok: true };
}

/**
 * The enqueuer — find every open Platform-routed Approval Request and queue ONE `platform-director`
 * job per target for the box lane to investigate. Idempotent (one director job per target, ever) and
 * a no-op while Platform isn't live+autonomous (the dormant-until-Phase-4 state). Best-effort.
 */
export async function enqueuePlatformDirectorJobs(admin: Admin): Promise<{ enqueued: number; slugs: string[] }> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return { enqueued: 0, slugs: [] }; // dormant until Phase 4 flips the flag
  const chart = await buildOrgChartGraph();

  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, status, pending_actions")
    .eq("status", "needs_approval")
    .limit(200);
  // plan-approval-routes-by-goal-owner: route by the JOB (a plan resolves to its goal's owner, not the
  // planner's platform default) so Ada never auto-decides another department's plan decomposition.
  type EnqueueJob = NonNullable<typeof jobs>[number];
  const targets: EnqueueJob[] = [];
  for (const j of (jobs || []) as EnqueueJob[]) {
    if (await routesToPlatformForJob(admin, j as Parameters<typeof routesToPlatformForJob>[1], chart, autonomy)) {
      targets.push(j);
    }
  }
  if (!targets.length) return { enqueued: 0, slugs: [] };

  // Dedup: never queue a second director job for a target that already has one (any status). A
  // deferred (escalated) target stays needs_approval, so this is what stops an infinite re-enqueue.
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("instructions")
    .eq("kind", "platform-director")
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
      kind: "platform-director",
      status: "queued",
      created_by: null,
      instructions: JSON.stringify({ target_job_id: t.id, target_kind: t.kind }),
    });
    if (!error) slugs.push(t.spec_slug || String(t.kind));
  }
  return { enqueued: slugs.length, slugs };
}

// ── Phase 2 — escort approved goals through their milestones ─────────────────────────────────────
// The chain-driving the operator did by HAND becomes the director's job: for each approved goal it owns,
// drive every UNBLOCKED, unshipped spec through self-sequence → build → merge → fold. It LEANS on the
// existing machinery (the blocked_by auto-queue `autoQueueUnblockedBy` fires reactively on a blocker's
// merge; the builder chain + auto-ship + fold carry a build the rest of the way) and adds only the
// PROACTIVE sweep + the audited advance: it kicks off the unblocked specs the reactive auto-queue never
// caught (the first spec of a goal, or one a missed enqueue left stranded) and logs an `escorted_goal`
// director_activity row each time it advances a goal. It NEVER reimplements the build/merge/fold path.
//
// Milestone progression of an ALREADY-APPROVED goal is inside the leash (auto). STARTING a new goal is
// not — that always escalates to the CEO (Phase 3), so the escort only ever touches a goal with real
// progress, and the per-spec blocker gate keeps it from queuing anything out of sequence.

/**
 * director-trust-phase-pr-provenance Phase 1 — when an escort lane spots a `status='shipped'` card that
 * lacks per-phase merge-hook provenance (`pr` tags), surface it to the CEO ONCE so the canonical miss
 * (5 phases live on main, board said `planned`) can't recur silently. The merge hook is the only authoritative
 * writer of `pr`, so a tagless shipped phase means we cannot prove the merge landed. Deduped by `drift:{slug}`
 * (one ping per spec until acted on); the activity row carries the suspect phase indices for the audit ledger.
 *
 * Phase 2 will give Ada a `request-audit` action so she can self-serve the cleanup; until then this is the
 * surface that gets the drift in front of the CEO. Best-effort; never blocks the calling lane.
 */
async function flagShippedWithoutProvenance(
  admin: Admin,
  workspaceId: string,
  card: SpecCard,
  lane: string,
): Promise<void> {
  // SpecPhase has no `index` field (phases are array-positioned), so derive indices from the parent array.
  const indices: number[] = [];
  const titles: string[] = [];
  card.phases.forEach((p, i) => {
    if (p.status === "shipped" && (p.pr ?? null) === null) {
      indices.push(i);
      if (p.title) titles.push(p.title);
    }
  });
  const diagnosis =
    `Spec "${card.slug}" is rolled up as shipped on the board, but ` +
    `${indices.length} phase(s) are tagged ✅ WITHOUT a merge-hook PR + SHA — drift suspect. ` +
    `Indices: ${indices.map((i) => `#${i + 1}`).join(", ") || "—"}${titles.length ? ` (${titles.join(" · ")})` : ""}. ` +
    `The merge hook is the only authoritative writer of \`pr\`, so a tagless ✅ phase means we can't prove ` +
    `the merge landed (e.g. a director hand-flip or an old reconciler pass). Run \`audit-spec-shipped-state\` ` +
    `on this slug to re-stamp the real phases with provenance, or drop the phantom phase if its work shipped elsewhere.`;
  try {
    await escalateDiagnosisToCeo(admin, {
      workspaceId,
      specSlug: card.slug,
      title: `Drift suspect: ${card.slug}`,
      diagnosis,
      dedupeKey: `drift:${card.slug}`,
      deepLink: `/dashboard/roadmap/${card.slug}`,
      escalationKind: "drift_suspect",
      metadata: { lane, drift_suspect_phase_indices: indices, drift_suspect_phase_titles: titles, autonomous: true },
    });
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: PLATFORM,
      actionKind: "drift_suspect_flagged",
      specSlug: card.slug,
      reason: `Shipped rollup with ${indices.length} tagless ✅ phase(s) — drift suspect; audit recommended.`,
      metadata: { lane, drift_suspect_phase_indices: indices, drift_suspect_phase_titles: titles, autonomous: true },
    });
  } catch {
    /* best-effort surface; the next escort/groom pass will re-detect and re-attempt */
  }
}

/**
 * Resolve the (effectively single-tenant) workspace the escort queues builds under — ride the latest
 * agent_jobs row's workspace, else the oldest workspace. Mirrors coverage-register's resolveWorkspace.
 */
async function resolveDirectorWorkspace(admin: Admin): Promise<string | null> {
  const { data: latestJob } = await admin
    .from("agent_jobs")
    .select("workspace_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromJob = (latestJob as { workspace_id?: string } | null)?.workspace_id;
  if (fromJob) return fromJob;
  const { data: ws } = await admin.from("workspaces").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (ws as { id?: string } | null)?.id ?? null;
}

/**
 * A greenlit goal the director MAY escort (the leash): one the CEO has greenlit (`status === "greenlit"`)
 * with real progress (`0 < pct < 100`) that isn't yet complete. The CEO's greenlight is now an EXPLICIT
 * goal state (director-proposed-goals) — no longer inferred from `pct > 0`. A `proposed` goal is skipped
 * (it awaits the CEO via its own Approval Request); a `greenlit` 0% goal is "ready for decomposition" (Pia,
 * Phase 2) and is NOT auto-started here; only a greenlit, in-progress goal is escorted toward its milestones.
 */
function isApprovedInProgress(goal: GoalCard): boolean {
  return goal.status === "greenlit" && goal.pct > 0 && goal.pct < 100;
}

/**
 * The STATIC buildable-spec predicate — the goal-admission gate for a greenlit-at-0% goal (and the loop's own
 * static skips, kept DRY). A spec is buildable when it's: NOT really-shipped, NOT a tagless-shipped drift
 * suspect (status=shipped), NOT deferred (parked), Vale-reviewed (specReviewDone), NOT opted out of auto-build,
 * and NOT still blocked. This is exactly the set of unconditional `continue` guards at the top of the escort
 * loop — but WITHOUT the DB/stateful guards (in-flight, loop-guard, build-gate), which decide what to do with
 * a buildable spec, not whether it's buildable at all. Used to admit a ready-at-0% goal INTO the escort.
 */
function isBuildableSpec(card: SpecCard): boolean {
  if (isCardFullyShippedWithProvenance(card)) return false; // really landed
  if (card.status === "shipped") return false; // tagless-shipped drift suspect — the loop surfaces it, never builds it
  if (card.status === "deferred") return false; // parked until the CEO un-defers it
  if (!specReviewDone(card)) return false; // in_review / un-Vale-passed — Vale must pass it first
  if (card.autoBuild === false) return false; // owner opted this spec out of auto-build
  if (card.blockedBy.some((b) => !b.cleared)) return false; // still blocked → its auto-queue fires on unblock
  return true;
}

/** Every distinct spec linked across a goal's milestones, resolved to its live SpecCard. */
function goalSpecs(goal: GoalCard, specBySlug: Map<string, SpecCard>): SpecCard[] {
  const slugs = new Set<string>();
  for (const m of goal.milestones) for (const s of m.specSlugs) slugs.add(s);
  return [...slugs].map((s) => specBySlug.get(s)).filter((c): c is SpecCard => !!c);
}

/**
 * goal-escort-ready-at-0pct: a greenlit goal the escort SHOULD enter. Either it's already in-progress (the
 * original leash, `isApprovedInProgress`) OR it's greenlit-but-unstarted (0%) yet ALREADY HAS ≥1 buildable
 * spec (authored directly, or after Pia decomposed it). A greenlit 0% goal with NO buildable spec stays
 * deferred to the human-gated planner (Pia) — the escort never auto-starts a goal that has nothing to build.
 */
function isEscortableGoal(goal: GoalCard, specBySlug: Map<string, SpecCard>): boolean {
  if (goal.status !== "greenlit" || goal.pct >= 100) return false;
  if (isApprovedInProgress(goal)) return true; // 0 < pct < 100 — in-flight, escort as before
  // greenlit at 0% — only enter if it has at least one genuinely-buildable spec ready for the queue
  return goalSpecs(goal, specBySlug).some(isBuildableSpec);
}

/** Per-goal outcome of one escort pass. */
export interface GoalEscortResult {
  goalSlug: string;
  goalTitle: string;
  pct: number;
  queued: string[]; // specs the escort kicked off (the gap the reactive auto-queue didn't cover)
  inFlight: string[]; // unblocked specs already building (auto-queue / chain / a manual build is handling it)
  escalated: string[]; // specs whose build hit the loop-guard → escalated to the CEO, never re-submitted
}

/**
 * One escort pass over every approved goal the Platform director owns. For each unblocked, unshipped spec
 * with NO build job yet, queue one (`created_by=null`, the agent enqueue — same shape as autoQueueUnblockedBy
 * + queueNextChainedPhase, so the chain/auto-ship/fold pick it up unchanged) and log an `escorted_goal` row.
 *
 * Idempotent (a spec that already has a build job is confirmed, never re-queued) and a NO-OP until Platform
 * is live+autonomous (dormant until Phase 4, exactly like the approval enqueuer above). Best-effort; the
 * caller logs the result. Never starts a new goal, never re-implements the build path.
 */
export async function escortApprovedGoals(admin: Admin): Promise<{ goals: GoalEscortResult[]; queued: string[]; escalated: string[] }> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return { goals: [], queued: [], escalated: [] }; // dormant until Phase 4 flips the flag

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return { goals: [], queued: [], escalated: [] };

  const [goals, { specs }] = await Promise.all([getGoals(), getRoadmap()]);
  const mine = goals.filter((g) => g.owner === PLATFORM);

  const specBySlug = new Map(specs.map((s) => [s.slug, s]));

  // director-proposed-goals (Phase 1) + goal-escort-ready-at-0pct: the goal's lifecycle state — not `pct > 0` —
  // decides escortability.
  //   - `proposed` → awaits the CEO via its OWN Approval Request (the proposed-goal job). The escort does NOT
  //     touch it and does NOT re-escalate it: surfacing it is the proposed-goal flow's job, not the escort's.
  //   - `greenlit` at 0% with NO buildable spec → greenlit-but-unstarted, READY FOR DECOMPOSITION (Pia,
  //     Phase 2). The escort never auto-starts a goal that has nothing to build, so it's left for the
  //     human-gated planner — no escalation, no auto-queue.
  //   - `greenlit` at 0% WITH ≥1 buildable spec (authored directly, or after Pia decomposed) → genuinely
  //     ready to build: the escort ENTERS it and queues those specs. (Without this it sat forever, since the
  //     old `pct > 0` gate excluded an at-0% goal whose specs were already reviewed + planned.)
  //   - `greenlit` in-progress (0 < pct < 100) → escorted toward its milestones, exactly as before.
  // This replaces the old "every 0% owned goal escalates as a new-goal greenlight request": a proposed goal
  // is now an explicit, self-surfacing artifact and a greenlit 0% goal is either awaiting-Pia (no specs yet)
  // or ready-to-build (decomposed) — the escort distinguishes the two by whether ≥1 spec is buildable.

  const owned = mine.filter((g) => isEscortableGoal(g, specBySlug));
  if (!owned.length) return { goals: [], queued: [], escalated: [] };

  // Build-gate (director-executable-plans-and-priority): if an active directive gates builds until a spec
  // ships, this lane queues NOTHING but the gate spec itself until then. Computed once per pass.
  const gate = await buildGate(admin, workspaceId, PLATFORM);

  const results: GoalEscortResult[] = [];
  const queuedAll: string[] = [];
  const escalatedAll: string[] = [];

  for (const goal of owned) {
    const queued: string[] = [];
    const inFlight: string[] = [];
    const escalated: string[] = [];
    for (const card of goalSpecs(goal, specBySlug)) {
      // director-trust-phase-pr-provenance Phase 1: a `shipped` rollup is only "really done" when every shipped
      // phase carries the merge hook's `pr` stamp. A tagless shipped phase is DRIFT SUSPECT — the escort surfaces
      // it to the CEO (deduped) instead of skipping past it, so the canonical miss (5 phases live on main, board
      // said `planned`) can't recur silently.
      if (isCardFullyShippedWithProvenance(card)) continue; // really landed (status=shipped + every phase has pr)
      if (card.status === "shipped") {
        await flagShippedWithoutProvenance(admin, workspaceId, card, `escortApprovedGoals (${goal.title})`);
        continue;
      }
      if (card.status === "deferred") continue; // parked — every auto-build lane skips a deferred spec until the CEO un-defers it (director-drives-all-specs-and-deferred-status Phase 1)
      if (!specReviewDone(card)) continue; // no-max-on-unreviewed-specs (PRIMARY): never queue a build for an in_review / un-vale-passed spec — Vale must pass it first or the claim-gate just bounces it after a Max session was already spun up
      if (gate && card.slug !== gate.gatedUntil && !card.critical) continue; // build-gate: pause routine, but let the gate spec + any **Priority:** critical (priority builds) through
      if (card.autoBuild === false) continue; // owner opted this spec out of auto-build (mirrors autoQueueUnblockedBy)
      if (card.blockedBy.some((b) => !b.cleared)) continue; // still blocked → the auto-queue fires when its last blocker ships

      const state = await specBuildState(admin, workspaceId, card.slug);

      // An active or already-landed build (auto-queue / chain / a manual build is handling it)? → confirm it's
      // moving (the escort's "did each land clean" check), don't stack a duplicate. (Phase 2 idempotency.)
      if (state.inFlight) {
        inFlight.push(card.slug);
        continue;
      }

      // Loop-guard — this build REPEATEDLY failed (≥ the cap) and nothing is in-flight. Stop: a deeper issue,
      // not something a resubmit fixes. Escalate the diagnosis to the CEO (to approve modifying the approach)
      // and NEVER re-queue — the leash forbids an infinite resubmit loop. Deduped, so it pings the CEO once.
      if (state.failedCount >= PLATFORM_DIRECTOR_LOOP_GUARD_MAX) {
        const diagnosis = `Build of "${card.slug}" (escorting ${goal.title}, ${goal.pct}%) failed ${state.failedCount}× and didn't land — likely a deeper issue, not a flaky retry${state.lastError ? ` (latest error: ${state.lastError.slice(0, 400)})` : ""}. I've stopped resubmitting; approve modifying the spec/approach and I'll carry it from there.`;
        const r = await escalateDiagnosisToCeo(admin, {
          workspaceId,
          specSlug: card.slug,
          title: `Build stuck: ${card.slug}`,
          diagnosis,
          dedupeKey: `loopguard:${card.slug}`,
          deepLink: `/dashboard/roadmap/${card.slug}`,
          escalationKind: "loop_guard",
          metadata: { goal_slug: goal.slug, pct: goal.pct, failed_attempts: state.failedCount, last_error: state.lastError ?? undefined },
        });
        if (r.emitted) {
          escalated.push(card.slug);
          escalatedAll.push(card.slug);
        } else if (r.error) {
          console.error(`[platform-director] CEO escalation FAILED to surface (loopguard:${card.slug}): ${r.error.message}`);
        }
        continue;
      }

      // The gap: an unblocked, unshipped spec of an approved goal with no in-flight build — either never queued,
      // or a prior attempt failed under the loop-guard cap (a bounded retry). Kick off its build — the existing
      // chain + auto-ship + fold + blocked_by auto-queue carry it from here (we don't rebuild them).
      const retry = state.failedCount > 0;
      const { error } = await admin.from("agent_jobs").insert({
        workspace_id: workspaceId,
        spec_slug: card.slug,
        kind: "build",
        status: "queued",
        created_by: null,
        instructions: `Escorted by the Platform/DevOps Director: ${goal.title} (${goal.pct}%) — ${card.slug} is unblocked; ${retry ? `re-attempt #${state.failedCount + 1} (prior build failed) — ` : ""}sequencing its build toward the next milestone.`,
      });
      if (!error) {
        queued.push(card.slug);
        queuedAll.push(card.slug);
        // derive-rollup-status: reflect the start on the board by moving the LEAF phase in_progress (the card
        // status DERIVES from the phase rollup — no direct card-status write). Best-effort.
        await markLeafPhaseInProgress(workspaceId, card.slug);
      }
    }

    if (queued.length || inFlight.length || escalated.length) {
      results.push({ goalSlug: goal.slug, goalTitle: goal.title, pct: goal.pct, queued, inFlight, escalated });
    }
    // Log an escort action only when we actually advanced the goal (queued new work) — an idle confirm-pass
    // shouldn't flood the audit log. The board post + richer EOD-recap slice land in Phase 4.
    if (queued.length) {
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM,
        actionKind: "escorted_goal",
        specSlug: queued[0],
        reason: `Escorting ${goal.title} (${goal.pct}%): sequenced ${queued.length} unblocked spec(s) toward the next milestone — ${queued.join(", ")}.`,
        metadata: { goal_slug: goal.slug, pct: goal.pct, queued, in_flight: inFlight, escalated, autonomous: true },
      });
    }
  }

  return { goals: results, queued: queuedAll, escalated: escalatedAll };
}

/** A SpecCard's phases mapped to the spec_card_state per-phase snapshot shape (the P6 PM-companion write). */
function phaseStatesOf(card: SpecCard): { index: number; title: string; status: SpecCard["phases"][number]["status"] }[] {
  return card.phases.map((p, i) => ({ index: i, title: p.title, status: p.status }));
}

/**
 * derive-rollup-status: mark a spec's leaf phase `in_progress` at BUILD START. The board status now DERIVES
 * from the phase rollup, so a started build must move a PHASE (not the card) to in_progress. Delegates to the
 * canonical `spec_phases` writer; best-effort (a failure must never break the build enqueue). No-op on a spec
 * with no planned phase (one-shot / already started).
 */
async function markLeafPhaseInProgress(workspaceId: string, slug: string): Promise<void> {
  try {
    const { markPhaseInProgress } = await import("@/lib/specs-table");
    await markPhaseInProgress(workspaceId, slug);
  } catch (e) {
    console.warn(`[platform-director] markLeafPhaseInProgress failed for ${slug}:`, e instanceof Error ? e.message : e);
  }
}

export interface FixEscortResult {
  /** unstarted authored fix specs (Repair-signature, no ✅ phase) whose build we queued. */
  fixQueued: string[];
  /** fix specs whose build repeatedly failed (≥ loop-guard cap) → escalated to the CEO. */
  escalated: string[];
}

/**
 * Escort the work both other lanes miss — **unstarted authored fix specs** (worker-grading-and-director-
 * management Phase 4; absorbed the removed director-escort-inflight-specs gap). The two existing lanes already
 * drive *started* work: escortApprovedGoals walks goal→milestone→spec trees, and board-grooming
 * (findGroomCandidates) drives every in-flight spec (≥1 ✅ + ≥1 ⏳) via a careful Max continue/split/escalate
 * investigation, regardless of goal linkage. The remaining gap is a spec authored by the box Repair /
 * Regression agent for a REAL bug that has **no shipped phase** (so grooming, which needs ≥1 ✅, can't see it)
 * and **no goal** (so the goal-walk can't see it) — whether it has 0 ⏳ phases or a `## Phase 1 — close it ⏳`
 * section the Repair agent now authors. Building it IS the director's `error_fix` mandate the CEO already
 * greenlit, so it's inside the leash — we don't blind-queue an unstarted FEATURE spec (a new product
 * capability, which has no Repair-signature and still escalates).
 *
 * The gate is the **Repair-signature** (`SpecCard.repairSignature`) + **the build-driver keystone** — Ada/Platform
 * is the SOLE builder, so the Platform director drives EVERY fix spec regardless of owner (CEO directive 2026-06-29:
 * build-driving is owner-agnostic via `platformDrivesSpec`). A repair-signed fix builds straight through (the
 * already-greenlit mandate) for any owner; a department going live+autonomous OPERATES + AUTHORS its specs but never
 * builds, so its fix specs stay with Ada. Same guards as the other escorts: dormant until
 * live+autonomous, skips blocked / opted-out / in-flight specs, and a build that failed ≥ the loop-guard cap
 * escalates to the CEO instead of re-queuing forever. On each queue it writes the P6 PM-companion mirror + an
 * `escorted_fix` activity row.
 */
export async function escortFixSpecs(admin: Admin): Promise<FixEscortResult> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return { fixQueued: [], escalated: [] };
  const chart = await buildOrgChartGraph();

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return { fixQueued: [], escalated: [] };

  const { specs } = await getRoadmap();
  const gate = await buildGate(admin, workspaceId, PLATFORM); // build-gate (director-executable-plans-and-priority): the gate spec is itself often a fix, so it's allowed; others wait
  const fixQueued: string[] = [];
  const escalated: string[] = [];

  for (const card of specs) {
    // director-trust-phase-pr-provenance Phase 1: skip only on a FULLY-shipped-with-provenance card; if the
    // rollup says shipped but a phase lacks `pr`, that's drift suspect — surface to the CEO (deduped), don't
    // silently skip past it.
    if (isCardFullyShippedWithProvenance(card)) continue; // really landed (status=shipped + every phase has pr)
    if (card.status === "shipped") {
      await flagShippedWithoutProvenance(admin, workspaceId, card, "escortFixSpecs");
      continue;
    }
    if (card.status === "deferred") continue; // parked — a deferred fix spec is skipped until the CEO un-defers it (director-drives-all-specs-and-deferred-status Phase 1)
    if (!specReviewDone(card)) continue; // no-max-on-unreviewed-specs (PRIMARY): a fix spec authored straight to planned still needs Vale's pass before a build is queued — else the claim-gate bounces it after a Max session was already spun up
    if (gate && card.slug !== gate.gatedUntil && !card.critical) continue; // build-gate: pause routine, but let the gate spec + any **Priority:** critical (priority builds) through
    if (card.autoBuild === false) continue; // owner opted out of auto-build
    if (card.blockedBy.some((b) => !b.cleared)) continue; // still blocked → its auto-queue fires on unblock

    // The gap: an UNSTARTED spec carrying a Repair-signature (an authored fix for a real bug). Ada drives
    // EVERY spec's build (owner-agnostic keystone routing — the owner is attribution, not the build driver).
    // The box Repair agent now authors fix specs with a `## Phase 1 — close it ⏳` section, so gating on
    // `phases.length === 0` skipped them.
    //
    // spec-goal-branch-pm-flow M2: "unstarted" = NO phase has BUILT (branch build_sha OR shipped). Under
    // branch-flow a phase builds on the spec branch (build_sha, in_progress) long BEFORE it earns a `pr` tag
    // (only M5 promotion stamps `pr`), so the old `provenanceShippedCount === 0` (pr-gated) read 0 for the
    // ENTIRE life of a branch-flow fix spec — once phase 1 had built on the branch but no build was active (the
    // gap between phases), this would re-queue a FRESH build from scratch, duplicating accumulated branch work.
    // `branchBuiltCount === 0` recognizes the branch-built phase as started (mirrors the init + groom lanes,
    // both rewired to branchBuiltCount in M2). The per-candidate `state.inFlight` check below also dedups.
    const isFixSpec = branchBuiltCount(card) === 0 && card.repairSignature && platformDrivesSpec(card.owner, chart, autonomy);
    if (!isFixSpec) continue;

    const state = await specBuildState(admin, workspaceId, card.slug);
    if (state.inFlight) continue; // a manual / prior-escort build is already carrying it

    // Loop-guard — repeated failures, nothing in-flight: stop re-queuing, escalate to the CEO (deduped).
    if (state.failedCount >= PLATFORM_DIRECTOR_LOOP_GUARD_MAX) {
      const diagnosis = `Build of authored fix spec "${card.slug}" failed ${state.failedCount}× and didn't land — likely a deeper issue, not a flaky retry${state.lastError ? ` (latest error: ${state.lastError.slice(0, 400)})` : ""}. I've stopped resubmitting; approve modifying the spec/approach and I'll carry it from there.`;
      const r = await escalateDiagnosisToCeo(admin, {
        workspaceId,
        specSlug: card.slug,
        title: `Build stuck: ${card.slug}`,
        diagnosis,
        dedupeKey: `loopguard:${card.slug}`,
        deepLink: `/dashboard/roadmap/${card.slug}`,
        escalationKind: "loop_guard",
        metadata: { kind: "fix", failed_attempts: state.failedCount, last_error: state.lastError ?? undefined },
      });
      if (r.emitted) escalated.push(card.slug);
      else if (r.error) console.error(`[platform-director] CEO escalation FAILED to surface (loopguard:${card.slug}): ${r.error.message}`);
      continue;
    }

    const retry = state.failedCount > 0;
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: card.slug,
      kind: "build",
      status: "queued",
      created_by: null,
      instructions: `Escorted by the Platform/DevOps Director: authored fix spec ${card.slug} is unblocked; ${retry ? `re-attempt #${state.failedCount + 1} (prior build failed) — ` : ""}building the bug fix.`,
    });
    if (error) continue;

    fixQueued.push(card.slug);
    // derive-rollup-status: move the LEAF phase in_progress so the board shows the fix moving (the card
    // status derives from the phase rollup).
    await markLeafPhaseInProgress(workspaceId, card.slug);
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: PLATFORM,
      actionKind: "escorted_fix",
      specSlug: card.slug,
      reason: `Escorting authored fix spec: queued ${card.slug}${retry ? ` (re-attempt #${state.failedCount + 1})` : ""} — building the bug fix.`,
      // director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive Phase 1: stamp the
      // OWNING function so the daily watch + audit ledger can see when the keystone is covering for a
      // department whose own director isn't live yet (director_function = me, owner_function = theirs).
      metadata: { spec_slug: card.slug, kind: "fix", retry, owner_function: card.owner ?? null, autonomous: true },
    });
  }

  return { fixQueued, escalated };
}

// ── escortSweep — drive in-flight + director-authored specs through to ship ─────────────────────
// director-escort-inflight-specs Phase 1. The director's existing standing pass investigates parks,
// grooms partially-shipped specs, lifts gated builds, etc. — but it does NOT actively drive specs the
// director ITSELF authored (groom/init/repair followups, fix specs) through to ship. So a build that
// errored out, a spec stuck `in_progress` with no agent_jobs row in flight, or a critical spec marked
// by the CEO can sit for hours before any lane re-touches it. escortSweep runs at the START of every
// standing pass and closes that gap with four mechanical lanes (no `claude -p` investigation — the
// follow-up lanes do that):
//   1. `queued_build`  — no build job ever for this slug                  → queue one + log
//   2. `failed_retry`  — exactly one failed build, nothing in-flight      → queue a retry build + log
//   3. `failed_repeat` — ≥2 failed builds, nothing in-flight              → escalate to CEO (deeper issue;
//                                                                          the groom/init lane re-investigates
//                                                                          if it has shipped phases)
//   4. `stalled`       — an active build older than the stall window with → log + escalate so the owner can
//                        no merge SHA yet                                   investigate (parked? branch-stuck?)
// derive-rollup-status: the old `status_drift` lane (a terminal-success build whose card mirror never caught
// up) is GONE — board status now DERIVES from the phase rollup, so that drift class is structurally
// impossible (a merge stamps the leaf phase shipped → the trigger rolls specs.status → the card derives it).
// Loop-guard: the SAME lane on the SAME slug ≥3× in 24h escalates instead of re-acting, so a build that
// always fails the same way (or a misclassified card) never enters an infinite re-enqueue. Every action
// stamps a `director_activity` row `kind='escorted'` with `metadata.lane` so the audit ledger + the EOD
// recap can read what each pass moved.

/** Active (queued/building/...) build statuses for stall detection — same set as ACTIVE_BUILD_STATUSES below. */
const ESCORT_ACTIVE_BUILD_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
]);

/** How long an active build may sit before the escort marks it stalled. */
export const ESCORT_STALL_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h

/** Loop-guard: SAME (slug, lane) escorted action ≥ this many times in the 24h window → escalate instead. */
export const ESCORT_LOOP_GUARD_MAX = 3;
export const ESCORT_LOOP_GUARD_WINDOW_MS = 24 * 60 * 60 * 1000;

/** "Authored by this director" — the director_activity action kinds the escort treats as the spec-author signal. */
const ESCORT_AUTHORED_ACTION_KINDS: readonly string[] = [
  "groomed_authored_spec",
  "init_authored_spec",
  "repair_authored_spec",
  "authored_fix",
];

/** The window the "authored recently by this director" criterion looks back over. */
export const ESCORT_AUTHORED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** A lane the escort took on one spec — the metadata.lane stamp + the recap surface. */
export type EscortLane =
  | "queued_build"
  | "failed_retry"
  | "failed_repeat"
  | "stalled"
  | "loop_guard";

/** Per-pass tally returned to the standing-pass log. */
export interface EscortSweepResult {
  scanned: number;
  queuedBuild: string[];
  failedRetry: string[];
  failedRepeat: string[];
  stalled: string[];
  escalated: string[];
  loopGuarded: string[];
  skipped: number;
}

interface EscortCandidate {
  slug: string;
  cardStatus: SpecStatus;
  critical: boolean;
  source: "in_progress" | "critical" | "authored";
}

/**
 * Lane-1 sources for this director. Pulls every spec_card_state row in the director's owner scope where:
 *   - status='in_progress', OR
 *   - status='planned' AND flags.critical=true, OR
 *   - the spec was authored by this director within the last ESCORT_AUTHORED_WINDOW_MS (director_activity
 *     `*_authored_spec` / `authored_fix` rows).
 * The first two come from spec_card_state directly; the third comes from director_activity (the spec may
 * not yet have a card row if no writer ran). Dedup by slug.
 */
async function findEscortCandidates(admin: Admin, workspaceId: string, scope: { specBySlug: Map<string, SpecCard>; isInScope: (card: SpecCard | undefined) => boolean }): Promise<EscortCandidate[]> {
  const out: EscortCandidate[] = [];
  const seen = new Set<string>();

  // Source 1+2 — the live mirror.
  const { data: states } = await admin
    .from("spec_card_state")
    .select("spec_slug, status, flags")
    .eq("workspace_id", workspaceId)
    .in("status", ["in_progress", "planned"])
    .limit(2000);
  for (const row of (states ?? []) as { spec_slug: string; status: SpecStatus; flags: SpecCardFlags | null }[]) {
    const card = scope.specBySlug.get(row.spec_slug);
    if (!scope.isInScope(card)) continue;
    const critical = !!row.flags?.critical;
    if (row.status === "in_progress") {
      seen.add(row.spec_slug);
      out.push({ slug: row.spec_slug, cardStatus: row.status, critical, source: "in_progress" });
    } else if (row.status === "planned" && critical) {
      seen.add(row.spec_slug);
      out.push({ slug: row.spec_slug, cardStatus: row.status, critical, source: "critical" });
    }
  }

  // Source 3 — specs THIS director authored within the window.
  const since = new Date(Date.now() - ESCORT_AUTHORED_WINDOW_MS).toISOString();
  const { data: authored } = await admin
    .from("director_activity")
    .select("spec_slug, action_kind, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("director_function", PLATFORM)
    .in("action_kind", ESCORT_AUTHORED_ACTION_KINDS)
    .gte("created_at", since)
    .limit(1000);
  for (const row of (authored ?? []) as { spec_slug: string | null; metadata: Record<string, unknown> | null }[]) {
    // The author lane records the NEW slug in metadata.followup_slug; fall back to spec_slug for `authored_fix`.
    const followup = typeof row.metadata?.["followup_slug"] === "string" ? (row.metadata["followup_slug"] as string) : null;
    const slug = followup || row.spec_slug || "";
    if (!slug || seen.has(slug)) continue;
    const card = scope.specBySlug.get(slug);
    if (!scope.isInScope(card)) continue;
    seen.add(slug);
    out.push({ slug, cardStatus: card?.status ?? "planned", critical: !!card?.critical, source: "authored" });
  }

  return out;
}

/** The latest build agent_jobs row for a spec — what the escort classifies its lane on. */
interface LatestBuild {
  status: string;
  createdAt: string;
  failedCount: number; // failed/needs_attention attempts within the build-state window
  lastError: string | null;
  lastMergeSha: string | null; // from spec_card_state — proxy for "merge landed"
}

async function loadLatestBuildState(admin: Admin, workspaceId: string, slug: string): Promise<{ latest: LatestBuild | null; bs: SpecBuildState }> {
  const bs = await specBuildState(admin, workspaceId, slug);
  const { data: rows } = await admin
    .from("agent_jobs")
    .select("status, created_at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .order("created_at", { ascending: false })
    .limit(1);
  const latestRow = (rows ?? [])[0] as { status?: string; created_at?: string } | undefined;
  if (!latestRow) return { latest: null, bs };
  // last_merge_sha lives on spec_card_state — pull it as the "merge landed" proxy.
  const { data: card } = await admin
    .from("spec_card_state")
    .select("last_merge_sha")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .maybeSingle();
  return {
    latest: {
      status: String(latestRow.status ?? ""),
      createdAt: String(latestRow.created_at ?? ""),
      failedCount: bs.failedCount,
      lastError: bs.lastError,
      lastMergeSha: ((card as { last_merge_sha?: string | null } | null)?.last_merge_sha) ?? null,
    },
    bs,
  };
}

/** Count of recent `escorted` activity rows for (slug, lane) within the loop-guard window. */
async function countRecentEscorted(admin: Admin, workspaceId: string, slug: string, lane: EscortLane): Promise<number> {
  const since = new Date(Date.now() - ESCORT_LOOP_GUARD_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("workspace_id", workspaceId)
    .eq("director_function", PLATFORM)
    .eq("action_kind", "escorted")
    .eq("spec_slug", slug)
    .gte("created_at", since)
    .limit(50);
  let n = 0;
  for (const r of (data ?? []) as { metadata: Record<string, unknown> | null }[]) {
    if (r.metadata?.["lane"] === lane) n++;
  }
  return n;
}

async function recordEscort(admin: Admin, args: { workspaceId: string; slug: string; lane: EscortLane; source: EscortCandidate["source"]; reason: string; extra?: Record<string, unknown> }): Promise<void> {
  await recordDirectorActivity(admin, {
    workspaceId: args.workspaceId,
    directorFunction: PLATFORM,
    actionKind: "escorted",
    specSlug: args.slug,
    reason: args.reason,
    metadata: { lane: args.lane, source: args.source, ...(args.extra ?? {}), autonomous: true },
  });
}

/**
 * The pre-grooming escort sweep — one pass over every in-flight / authored / critical-planned spec the
 * Platform director drives, dispatching each into ONE of the five lanes (or loop-guard escalating). Runs
 * at the START of every standing pass (before grooming + the init lane), so a stalled author-follow-up or
 * a failed-once retry lands the moment the pass starts instead of waiting for grooming's next tick. Dormant
 * until Platform is live+autonomous; best-effort per spec — one failure never blocks the rest.
 */
export async function escortSweep(admin: Admin): Promise<EscortSweepResult> {
  const empty: EscortSweepResult = { scanned: 0, queuedBuild: [], failedRetry: [], failedRepeat: [], stalled: [], escalated: [], loopGuarded: [], skipped: 0 };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty;
  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return empty;
  const chart = await buildOrgChartGraph();

  const { specs } = await getRoadmap();
  const specBySlug = new Map(specs.map((s) => [s.slug, s]));
  const isInScope = (card: SpecCard | undefined) => !!card && platformDrivesSpec(card.owner, chart, autonomy);

  const candidates = await findEscortCandidates(admin, workspaceId, { specBySlug, isInScope });
  const result: EscortSweepResult = { ...empty };
  result.scanned = candidates.length;

  for (const c of candidates) {
    const card = specBySlug.get(c.slug);
    if (!card) {
      result.skipped++;
      continue;
    }
    // director-trust-phase-pr-provenance Phase 1: only skip on a FULLY-shipped-with-provenance card. A
    // `status='shipped'` rollup without every phase carrying a `pr` stamp is DRIFT SUSPECT (the merge hook
    // is the only authoritative `pr` writer) — flag it so the next groom/init/CEO touch can audit it,
    // instead of silently treating it as done.
    if (isCardFullyShippedWithProvenance(card)) {
      // The spec really shipped (every phase has its merge-hook PR + SHA) — nothing for the escort to drive.
      result.skipped++;
      continue;
    }
    if (card.status === "shipped") {
      await flagShippedWithoutProvenance(admin, workspaceId, card, "escortSweep");
      result.skipped++;
      continue;
    }
    if (card.status === "deferred") {
      result.skipped++;
      continue;
    }
    if (!specReviewDone(card)) {
      // no-max-on-unreviewed-specs (PRIMARY): the escort sweep's queued_build / failed_retry lanes insert a
      // build job. Never queue one for an in_review / un-vale-passed spec — Vale must pass it first, else the
      // claim-gate just bounces the build after Bo already spun up a Max session. (Bo's claim-selection hard-skip
      // is the backstop.)
      result.skipped++;
      continue;
    }
    if (card.autoBuild === false) {
      // Owner opted this spec out of auto-build — the escort never queues for it.
      result.skipped++;
      continue;
    }
    if (card.blockedBy.some((b) => !b.cleared)) {
      // Still blocked — its auto-queue fires when its last blocker ships.
      result.skipped++;
      continue;
    }

    let lane: EscortLane | null = null;
    let reason = "";
    let extra: Record<string, unknown> = {};

    const { latest, bs } = await loadLatestBuildState(admin, workspaceId, c.slug);

    if (!latest) {
      lane = "queued_build";
      reason = `No build job has ever existed for ${c.slug} (${c.source}, status=${c.cardStatus}${c.critical ? ", critical" : ""}) — queuing one.`;
    } else if (latest.status === "merged" || latest.status === "completed") {
      // derive-rollup-status: the `status_drift` lane is RETIRED. A spec's board status now DERIVES from its
      // phase rollup (the same rollup the DB trigger maintains on specs.status), so a "merged build but the
      // card never caught up" drift is structurally impossible — the merge hook stamps the leaf phase
      // shipped and the derived card reflects it instantly. There is nothing for the escort to reconcile on
      // a terminal-success build; the groom lane advances the next phase if more remain.
      result.skipped++;
      continue;
    } else if (FAILED_BUILD_STATUSES.has(latest.status) && !bs.activeBuild) {
      if (bs.failedCount <= 1) {
        lane = "failed_retry";
        reason = `Last build of ${c.slug} ${latest.status} (1 failed attempt, no in-flight) — queuing a retry. ${latest.lastError ? `Latest: ${latest.lastError.slice(0, 200)}` : ""}`.trim();
      } else {
        lane = "failed_repeat";
        reason = `Build of ${c.slug} has failed ${bs.failedCount}× with nothing in-flight — likely a deeper issue, not a flaky retry. Routing to the groom/init lane for re-investigation (fix-spec or dismiss).`;
      }
      extra = { failed_count: bs.failedCount, last_error: latest.lastError ?? undefined };
    } else if (ESCORT_ACTIVE_BUILD_STATUSES.has(latest.status)) {
      const ageMs = Date.now() - new Date(latest.createdAt || 0).getTime();
      if (ageMs > ESCORT_STALL_WINDOW_MS && !latest.lastMergeSha) {
        lane = "stalled";
        reason = `Build of ${c.slug} has been ${latest.status} for ${(ageMs / 3_600_000).toFixed(1)}h with no merge SHA — stuck (parked? missing dep? branch-stuck?). Surfacing for investigation.`;
        extra = { build_status: latest.status, age_hours: Number((ageMs / 3_600_000).toFixed(1)) };
      } else {
        // In-flight and within the stall window — leave it alone.
        result.skipped++;
        continue;
      }
    } else {
      // Anything else (held, dismissed, blocked_on_usage, …) — leave it for the lane that owns that status.
      result.skipped++;
      continue;
    }

    // Loop-guard — same (slug, lane) action ≥ ESCORT_LOOP_GUARD_MAX times in the last 24h → escalate.
    const priorActions = await countRecentEscorted(admin, workspaceId, c.slug, lane);
    if (priorActions >= ESCORT_LOOP_GUARD_MAX) {
      const diagnosis = `Escort sweep has taken the same action (${lane}) on ${c.slug} ${priorActions}× in the last 24h without it sticking — a deeper issue, not something another retry fixes. Stopping the loop and asking you to take a look.`;
      const r = await escalateDiagnosisToCeo(admin, {
        workspaceId,
        specSlug: c.slug,
        title: `Escort stuck: ${c.slug}`,
        diagnosis,
        dedupeKey: `escort-loopguard:${c.slug}:${lane}`,
        deepLink: `/dashboard/roadmap/${c.slug}`,
        escalationKind: "escort_loop_guard",
        metadata: { lane, prior_actions: priorActions, ...extra },
      });
      if (r.emitted) {
        result.loopGuarded.push(c.slug);
        result.escalated.push(c.slug);
        await recordEscort(admin, { workspaceId, slug: c.slug, lane: "loop_guard", source: c.source, reason: `Loop-guard fired on lane=${lane}: ${priorActions} prior actions in 24h. Escalated to CEO.`, extra: { original_lane: lane, prior_actions: priorActions } });
      } else if (r.error) {
        console.error(`[platform-director] escortSweep loop-guard escalation FAILED for ${c.slug}:`, r.error.message);
      }
      continue;
    }

    // Apply the lane's action.
    try {
      if (lane === "queued_build" || lane === "failed_retry") {
        const retry = lane === "failed_retry";
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: workspaceId,
          spec_slug: c.slug,
          kind: "build",
          status: "queued",
          created_by: null,
          instructions: `Escorted by the Platform/DevOps Director (escort-sweep, lane=${lane}): ${c.slug}${retry ? ` re-attempt #${bs.failedCount + 1} (prior build ${latest?.status})` : " — no prior build"}; building the spec.`,
        });
        if (error) {
          console.warn(`[platform-director] escortSweep ${lane} enqueue failed for ${c.slug}: ${error.message}`);
          continue;
        }
        // derive-rollup-status: signal the start by moving the LEAF phase in_progress (the card status derives
        // from the phase rollup — no direct card-status write). Best-effort.
        await markLeafPhaseInProgress(workspaceId, c.slug);
        if (lane === "queued_build") result.queuedBuild.push(c.slug);
        else result.failedRetry.push(c.slug);
        await recordEscort(admin, { workspaceId, slug: c.slug, lane, source: c.source, reason, extra });
      } else if (lane === "failed_repeat") {
        const r = await escalateDiagnosisToCeo(admin, {
          workspaceId,
          specSlug: c.slug,
          title: `Build keeps failing: ${c.slug}`,
          diagnosis: `${reason} ${latest?.lastError ? `Latest error: ${latest.lastError.slice(0, 400)}` : ""}`.trim(),
          dedupeKey: `escort-failed-repeat:${c.slug}`,
          deepLink: `/dashboard/roadmap/${c.slug}`,
          escalationKind: "escort_failed_repeat",
          metadata: extra,
        });
        if (r.emitted) {
          result.failedRepeat.push(c.slug);
          result.escalated.push(c.slug);
          await recordEscort(admin, { workspaceId, slug: c.slug, lane, source: c.source, reason, extra });
        } else if (r.error) {
          console.error(`[platform-director] escortSweep failed-repeat escalation FAILED for ${c.slug}:`, r.error.message);
        }
      } else if (lane === "stalled") {
        const r = await escalateDiagnosisToCeo(admin, {
          workspaceId,
          specSlug: c.slug,
          title: `Build stalled: ${c.slug}`,
          diagnosis: reason,
          dedupeKey: `escort-stalled:${c.slug}`,
          deepLink: `/dashboard/roadmap/${c.slug}`,
          escalationKind: "escort_stalled",
          metadata: extra,
        });
        if (r.emitted) {
          result.stalled.push(c.slug);
          result.escalated.push(c.slug);
          await recordEscort(admin, { workspaceId, slug: c.slug, lane, source: c.source, reason, extra });
        } else if (r.error) {
          console.error(`[platform-director] escortSweep stalled escalation FAILED for ${c.slug}:`, r.error.message);
        }
      }
    } catch (e) {
      console.warn(`[platform-director] escortSweep ${lane} action failed for ${c.slug}:`, e instanceof Error ? e.message : e);
    }
  }

  return result;
}

// ── Phase 3 — loop-guard + CEO escalation (the high-stakes calls) ─────────────────────────────────
// The leash is hard, so the high-stakes calls ALWAYS route UP to the CEO, never get rubber-stamped or
// resubmitted forever:
//   - a build that REPEATEDLY fails on the same error → STOP (a deeper issue), diagnose, escalate.
//   - a destructive / irreversible action, an out-of-leash request, or anything the runner can't confirm
//     sound → escalate the routed Approval Request to the CEO with the director's written diagnosis.
//   - starting a NEW goal (a zero-progress owned goal) → only the CEO greenlights goals → escalate.
// Every escalation reuses the EXISTING M2 inbox (a routed Approval Request notification — the inbox API
// shows an item to a role iff `metadata.routed_to_function === role`); we never build a parallel inbox.

/** Loop-guard: a build that fails to land after this many attempts → escalate to CEO, never re-submit. */
export const PLATFORM_DIRECTOR_LOOP_GUARD_MAX = 2;

/** The window the loop-guard counts recent failed build attempts over (mirrors the regression agent). */
export const PLATFORM_DIRECTOR_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** A build job's status means it FAILED (the loop-guard counts these). Everything else = active or landed. */
const FAILED_BUILD_STATUSES: ReadonlySet<string> = new Set(["failed", "needs_attention"]);

/**
 * A build job's status means it is ACTIVELY building (don't re-queue — a duplicate would result). A LANDED
 * build (`completed` / `merged`) is deliberately NOT here: a phase that just landed should TRIGGER the next
 * phase via grooming, not start a cooldown. See docs/brain/specs/groom-advance-next-phase-after-merge.md.
 */
const ACTIVE_BUILD_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
]);

/**
 * The build/plan pool ceiling — the SATURATION TARGET's denominator (director-initiation-throughput Phase 1).
 * MUST stay in sync with `scripts/builder-worker.ts` `MAX_CONCURRENT` (the box's lane count). The REAL ceiling
 * is Max rate limits (Phase 4's 529-backoff), not this number — bump both together to widen the pool.
 */
export const BUILD_POOL_CAPACITY = 8;

/** Statuses a build/plan job sits in while it OCCUPIES or is HEADED FOR a lane (queued included) — the
 *  saturation denominator. `claimed` (the RPC's pre-launch flip) counts; a terminal/held job does not.
 *
 *  ⭐ PARKED ≠ RUNNING/HEADED (box-fill-8-lanes). `needs_input`/`needs_approval` are DELIBERATELY EXCLUDED:
 *  a build parked on a human ("1 build paused — storefront-optimizer, awaiting owner action") is NOT on a
 *  lane and is NOT headed for one until the owner acts — it consumes ZERO lane capacity. Counting parked
 *  builds here read the pool "full" when lanes were wide open, so the director GROOMED/INITIATED nothing and
 *  queued builds sat 30+ min behind a couple of parked ones. The denominator now counts ONLY builds that
 *  occupy a lane (`claimed`/`building`) or are genuinely headed for one (`queued`/`queued_resume`); a parked
 *  build must never reduce the lanes available to enqueue + run OTHER queued work. `queued` stays IN (it's
 *  headed for a lane) so the pass tops up to capacity without OVER-queuing — but parked is out.
 *
 *  Note the box CLAIM loop (`scripts/builder-worker.ts`, `while (countOther() < MAX_CONCURRENT)`) already
 *  computes free lanes as `8 − running` from its in-memory `active` map (a parked build ends its session, so
 *  it's removed from `active` and holds no lane) — the claim path was never parked-inclusive. This is the
 *  matching fix on the ENQUEUE side so the queue actually gets filled to feed those open lanes. */
const INFLIGHT_POOL_STATUSES = ["queued", "claimed", "building", "queued_resume"];

/**
 * Saturation target (director-initiation-throughput Phase 1): how many MORE builds the pool can take right
 * now = {@link BUILD_POOL_CAPACITY} − (build/plan jobs occupying or headed for a lane). Counts the
 * lane-bound statuses (queued/claimed/building/queued_resume) — `queued` included so a build queued earlier
 * in THIS pass shrinks the target for the next lane (the pass tops the pool up to capacity and never
 * over-fills it). PARKED builds (needs_input/needs_approval) are NOT counted: parked on a human ⇒ off-lane ⇒
 * must not throttle topping up the pool for other work. When lanes are full it returns 0 (enqueue nothing);
 * with 2 idle it returns 2; with 8 it returns 8. Clamped ≥0. Fail-CLOSED: a read error yields 0 so a
 * transient blip never over-saturates.
 */
export async function idleBuildCapacity(admin: Admin, workspaceId: string): Promise<number> {
  try {
    const { count } = await admin
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .in("kind", ["build", "plan"])
      .in("status", INFLIGHT_POOL_STATUSES);
    return Math.max(0, BUILD_POOL_CAPACITY - (count ?? 0));
  } catch {
    return 0;
  }
}

/** One escort spec's build state — what the escort reads to decide queue vs in-flight vs loop-guard. */
export interface SpecBuildState {
  /**
   * an active (queued/building/…) OR already-landed (completed/merged) build exists. Back-compat signal for
   * the escort's duplicate-guard; grooming gates on {@link activeBuild} instead so a merged phase advances.
   */
  inFlight: boolean;
  /** an ACTIVE (queued/building/needs_input/needs_approval/queued_resume) build exists — a landed one does NOT count. */
  activeBuild: boolean;
  /** failed/needs_attention build attempts within the window. */
  failedCount: number;
  /** the most recent failure's error text (for the diagnosis). */
  lastError: string | null;
  /** total build jobs seen for the spec. */
  total: number;
}

/**
 * Read the recent build jobs for a spec and classify them: is one active/landed (don't re-queue), how
 * many have FAILED (the loop-guard count), and the latest failure's error. The escort uses this to pick
 * queue (gap-fill) · retry (failed but under the cap) · in-flight (leave it) · loop-guard (escalate).
 */
export async function specBuildState(admin: Admin, workspaceId: string, specSlug: string): Promise<SpecBuildState> {
  const sinceIso = new Date(Date.now() - PLATFORM_DIRECTOR_RECENT_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("agent_jobs")
    .select("status, error, created_at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", specSlug)
    .eq("kind", "build")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = (data ?? []) as Array<{ status?: string; error?: string | null }>;
  let inFlight = false;
  let activeBuild = false;
  let failedCount = 0;
  let lastError: string | null = null;
  for (const r of rows) {
    const status = String(r.status ?? "");
    // A `held` build (goal-milestone-build-sequencing Phase 3) is a CANCELLED out-of-order fan-out: it counts
    // as NEITHER in-flight NOR a failure, so once the reconcile's newly-applied blockers clear, the escort
    // re-releases the spec fresh (it isn't suppressed as in-flight, and it doesn't trip the loop-guard).
    if (status === SEQUENCE_HELD_STATUS) continue;
    if (FAILED_BUILD_STATUSES.has(status)) {
      failedCount++;
      if (lastError === null && r.error) lastError = String(r.error);
    } else {
      inFlight = true; // active OR landed: queued / building / needs_input / needs_approval / queued_resume / completed / merged
      if (ACTIVE_BUILD_STATUSES.has(status)) activeBuild = true; // active only — a landed (completed/merged) build does NOT block grooming
    }
  }
  return { inFlight, activeBuild, failedCount, lastError, total: rows.length };
}

/**
 * Escalate a routed Approval Request to the CEO — the director declined to auto-approve (out of leash,
 * destructive/irreversible, or unconfirmable), so it routes UP carrying its written diagnosis INLINE.
 * Reuses the M2 notification (it just flips `routed_to_function` to the CEO + prepends the diagnosis), so
 * the CEO inbox shows it instead of Platform's. If the reconciler hasn't emitted the notification yet,
 * we create a CEO-routed one (idempotent on agent_job_id — the reconciler then skips it). Best-effort.
 */
/**
 * The director identity carried into a CEO escalation — the slug used in the metadata's
 * `escalated_by_director` field and the human label that prefixes the escalation note. Default is
 * Ada (Platform/DevOps Director); the Growth director (growth-director-agent Phase 3) reuses this
 * function with `{slug:'growth', label:'Growth Director'}` so the CEO inbox correctly attributes
 * the escalation to whoever raised it.
 */
export interface EscalatingDirector {
  slug: string;
  label: string;
}

const ADA_IDENTITY: EscalatingDirector = { slug: PLATFORM, label: "Ada (Platform/DevOps Director)" };

export async function escalateApprovalRequestToCeo(
  admin: Admin,
  target: DirectorTargetJob,
  diagnosis: string,
  director: EscalatingDirector = ADA_IDENTITY,
): Promise<{ ok: boolean; created: boolean }> {
  const note = `🛠️ ${director.label} escalated this to you — outside the leash / a call only you should make:\n${diagnosis}`.slice(0, 4000);
  const { data: notifs } = await admin
    .from("dashboard_notifications")
    .select("id, body, metadata")
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("dismissed", false)
    .limit(2000);
  const existing = (notifs ?? []).find((n) => (n.metadata as Record<string, unknown> | null)?.["agent_job_id"] === target.id);

  if (existing) {
    const meta = { ...((existing.metadata as Record<string, unknown> | null) ?? {}), routed_to_function: CEO, escalated_by_director: director.slug, escalation_reason: diagnosis.slice(0, 2000) };
    const body = `${note}\n\n${(existing.body as string) ?? ""}`.slice(0, 4000);
    const { error } = await admin.from("dashboard_notifications").update({ metadata: meta, body, read: false }).eq("id", existing.id);
    return { ok: !error, created: false };
  }

  // No routed request yet (the reconciler hasn't run) — emit a CEO-routed one ourselves so the escalation
  // is durable. The reconciler is idempotent on agent_job_id, so it won't double-emit; and the target stays
  // needs_approval, so the reconciler keeps (never dismisses) it until the CEO decides.
  const content = buildApprovalContent(target as unknown as ApprovalJobRow);
  const meta = {
    agent_job_id: target.id,
    kind: target.kind,
    spec_slug: target.spec_slug ?? null,
    raised_by_function: ownerFunctionForKind(target.kind) ?? CEO,
    routed_to_function: CEO,
    approve_action_id: inlineApproveActionId(target as unknown as ApprovalJobRow),
    deep_link: approvalDeepLink(target.kind, target.spec_slug ?? null),
    escalated_by_director: director.slug,
    escalation_reason: diagnosis.slice(0, 2000),
  };
  const { error } = await admin.from("dashboard_notifications").insert({
    workspace_id: target.workspace_id,
    type: APPROVAL_REQUEST_TYPE,
    title: content.title,
    body: `${note}\n\n${content.body}`.slice(0, 4000),
    link: meta.deep_link,
    metadata: meta,
    read: false,
    dismissed: false,
  });
  return { ok: !error, created: true };
}

/**
 * Surface a director DIAGNOSIS to the CEO inbox — a high-stakes call with NO approvable target job (a
 * loop-guard "deeper issue," or a zero-progress owned goal only the CEO can greenlight). Emits a CEO-routed
 * Approval Request notification (no inline approve — it deep-links the CEO to the spec/goal to decide) AND
 * an `escalated` director_activity row. RELIABLE-SURFACE order (notification-first, error-checked, activity-
 * second): a failed notification insert returns `{ emitted:false, error }` and writes NO `escalated` row, so
 * the ledger never claims an escalation the inbox never showed. DEDUPED on `dedupeKey` against an EXISTING
 * `dashboard_notifications` row (NOT the activity ledger) so a logged-but-unsurfaced escalation retries;
 * once surfaced it pings once (survives a dismissed/read one). Carries NO `agent_job_id` so the reconciler —
 * which dismisses any request whose job left needs_approval — never reaps this standalone escalation.
 */
/**
 * The CEO-routed Approval Request notification payload for a director DIAGNOSIS escalation. Shared by the live
 * escalate path (`escalateDiagnosisToCeo`) AND the Phase-2 reconcile backstop (`reconcileSwallowedEscalations`),
 * so a re-emitted notification is BYTE-FOR-BYTE the shape the inbox already renders — no inline approve (it
 * deep-links the CEO to the spec/goal to decide), `routed_to_function=CEO`, and the `dedupe_key` the dedupe holds on.
 */
function ceoEscalationNotification(args: {
  workspaceId: string;
  specSlug: string | null;
  title: string;
  diagnosis: string;
  dedupeKey: string;
  deepLink: string;
  escalationKind: string;
}) {
  const note = `🛠️ Ada (Platform/DevOps Director) escalated this to you:\n${args.diagnosis}`.slice(0, 4000);
  return {
    workspace_id: args.workspaceId,
    type: APPROVAL_REQUEST_TYPE,
    title: args.title.slice(0, 200),
    body: note,
    link: args.deepLink,
    metadata: {
      routed_to_function: CEO,
      escalated_by_director: PLATFORM,
      escalation_kind: args.escalationKind,
      escalation_reason: args.diagnosis.slice(0, 2000),
      dedupe_key: args.dedupeKey,
      spec_slug: args.specSlug ?? null,
      deep_link: args.deepLink,
      approve_action_id: null,
    },
    read: false,
    dismissed: false,
  };
}

export async function escalateDiagnosisToCeo(
  admin: Admin,
  args: { workspaceId: string; specSlug: string | null; title: string; diagnosis: string; dedupeKey: string; deepLink: string; escalationKind: string; metadata?: Record<string, unknown> },
): Promise<{ emitted: boolean; error?: PostgrestError }> {
  // Dedup on a notification that ACTUALLY EXISTS — one CEO-routed notification per dedupeKey, ever (survives
  // a dismissed/read one). We key on dashboard_notifications, NOT the director_activity ledger: a
  // logged-but-unsurfaced escalation (an `escalated` activity row with no matching notification — the exact
  // bug this spec fixes) must NOT suppress the retry. If the notification is missing, this re-emits it.
  const { data: prior } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("metadata->>dedupe_key", args.dedupeKey)
    .limit(1);
  if ((prior ?? []).length > 0) return { emitted: false };

  // Notification FIRST, checked — a surface nobody can see is worse than none. If the insert fails (constraint/
  // RLS/shape), do NOT silently proceed: surface the error and do NOT write a phantom `escalated` activity row
  // (so the dedupe ledger never marks a never-surfaced escalation as done). The caller logs a hard warning.
  const { error: notifError } = await admin.from("dashboard_notifications").insert(ceoEscalationNotification(args));
  if (notifError) return { emitted: false, error: notifError };

  // Activity SECOND — only once the notification row actually landed. Now the audit ledger and the inbox agree.
  await recordDirectorActivity(admin, {
    workspaceId: args.workspaceId,
    directorFunction: PLATFORM,
    actionKind: "escalated",
    specSlug: args.specSlug,
    reason: args.diagnosis,
    metadata: { ...(args.metadata ?? {}), escalation_kind: args.escalationKind, dedupe_key: args.dedupeKey, autonomous: true },
  });
  return { emitted: true };
}

// ── Phase 2 (director-escalations-must-surface-to-ceo) — reconcile the already-swallowed escalations ─────
// Phase 1 stopped NEW escalations from being logged-but-invisible. But escalations swallowed BEFORE the fix
// (the agent-outage-resilience P3 `groom_unsure` at 02:03, and any sibling) already sit in the ledger as an
// `escalated` director_activity row with NO matching CEO notification — recorded, yet invisible, silently
// stranding the decision. This standing backstop in the director pass finds those orphans and re-emits the
// missing CEO notification ONCE, retroactively surfacing them so the CEO can finally act.

/** A re-emit the backstop performed: the escalation's dedupe key + the spec it stranded (for the pass log). */
export interface EscalationReconcileResult {
  /** dedupe keys whose missing CEO notification this pass re-emitted. */
  reEmitted: string[];
  /** distinct `escalated` activity dedupe keys checked against the live inbox. */
  checked: number;
}

/** The CEO's deep-link target for a logged escalation, reconstructed from the activity row (no link stored). */
function reconcileDeepLink(specSlug: string | null, meta: Record<string, unknown>): string {
  if (specSlug) return `/dashboard/roadmap/${specSlug}`;
  const goalSlug = meta["goal_slug"];
  if (typeof goalSlug === "string" && goalSlug) return `/dashboard/roadmap/goals/${goalSlug}`;
  return "/dashboard/roadmap";
}

/** A human title for a reconciled escalation, reconstructed per escalation_kind (the original wasn't stored). */
function reconcileTitle(escalationKind: string, specSlug: string | null, meta: Record<string, unknown>): string {
  const target =
    specSlug ??
    (typeof meta["goal_slug"] === "string" ? (meta["goal_slug"] as string) : null) ??
    (typeof meta["signature"] === "string" ? (meta["signature"] as string) : "") ??
    "";
  switch (escalationKind) {
    case "loop_guard":
      return `Build stuck: ${target}`;
    case "groom_unsure":
      return `Grooming needs a call: ${target}`;
    case "init-unsure":
    case "initguard":
      return `Initiation needs a call: ${target}`;
    case "new_goal":
      return `Greenlight needed: ${target}`;
    case "external_blocker":
      return `External blocker — your call: ${target}`;
    default:
      return target ? `Escalation needs your call: ${target}` : "Escalation needs your call";
  }
}

/**
 * The Phase-2 backstop. Find every `escalated` director_activity row (the escalation ledger) whose CEO
 * notification is MISSING from the live inbox (matched by `dedupe_key`) and re-emit that notification ONCE,
 * reusing the SAME shape the live path emits. Reconciles the NOTIFICATION ONLY — the `escalated` activity row
 * already documents the reasoning, so we never write a second one (which would inflate the recap's escalated
 * count). Idempotent: once re-emitted the dedupe_key is in the inbox, so the next pass (and the live escalate
 * path) skip it. Best-effort and DORMANT until Platform is live+autonomous (like the escort + the enqueuer).
 */
export async function reconcileSwallowedEscalations(admin: Admin): Promise<EscalationReconcileResult> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return { reEmitted: [], checked: 0 }; // dormant until activation flips the flag

  // The escalation ledger — every `escalated` row the director ever logged that carries a dedupe_key.
  const { data: acts } = await admin
    .from("director_activity")
    .select("workspace_id, spec_slug, reason, metadata, created_at")
    .eq("director_function", PLATFORM)
    .eq("action_kind", "escalated")
    .order("created_at", { ascending: false })
    .limit(1000);
  const escalations = (acts ?? []).filter((a) => typeof (a.metadata as Record<string, unknown> | null)?.["dedupe_key"] === "string");
  if (!escalations.length) return { reEmitted: [], checked: 0 };

  // The CEO-routed escalation notifications that ACTUALLY EXIST, keyed by dedupe_key (survives a dismissed/read
  // one — same "an actually-existing notification" rule Phase 1's dedupe uses). A logged escalation whose key is
  // absent here is the swallowed bug.
  const { data: notifs } = await admin
    .from("dashboard_notifications")
    .select("metadata")
    .eq("type", APPROVAL_REQUEST_TYPE)
    .limit(5000);
  const surfaced = new Set<string>();
  for (const n of notifs ?? []) {
    const k = (n.metadata as Record<string, unknown> | null)?.["dedupe_key"];
    if (typeof k === "string") surfaced.add(k);
  }

  // One re-emit per missing dedupe_key. Rows are newest-first, so the FIRST row for a key carries the freshest
  // reasoning; `handled` collapses repeats so we never insert two notifications for the same escalation.
  const reEmitted: string[] = [];
  const handled = new Set<string>();
  for (const a of escalations) {
    const meta = (a.metadata as Record<string, unknown> | null) ?? {};
    const dedupeKey = String(meta["dedupe_key"]);
    if (handled.has(dedupeKey)) continue;
    handled.add(dedupeKey);
    if (surfaced.has(dedupeKey)) continue; // already in the inbox — nothing swallowed

    const workspaceId = a.workspace_id as string;
    const specSlug = (a.spec_slug as string | null) ?? null;
    const escalationKind = String(meta["escalation_kind"] ?? "escalated");
    const diagnosis = String(a.reason ?? "").slice(0, 4000);
    const deepLink = reconcileDeepLink(specSlug, meta);

    const { error } = await admin.from("dashboard_notifications").insert(
      ceoEscalationNotification({
        workspaceId,
        specSlug,
        title: reconcileTitle(escalationKind, specSlug, meta),
        diagnosis,
        dedupeKey,
        deepLink,
        escalationKind,
      }),
    );
    if (error) {
      console.error(`[platform-director] reconcile FAILED to re-emit swallowed escalation (${dedupeKey}): ${error.message}`);
      continue;
    }
    surfaced.add(dedupeKey); // belt-and-suspenders: don't re-emit again within this same pass
    reEmitted.push(dedupeKey);
  }
  return { reEmitted, checked: handled.size };
}

// ── Phase 1 (director-zero-backlog-error-autonomy) — drain the OPEN error backlog to a terminal state ──
// Rafa ([[../libraries/repair-agent]]) is EVENT-triggered: it fires the moment the Control Tower records a
// NEW signature (recordError / a newly-opened loop_alert). But an error that slipped that trigger — recorded
// during an outage window, before Platform went live, or on a skipped enqueue — just SITS open: nothing
// re-drives it, so the backlog never drains on its own. This standing reconciler is the backstop that
// GUARANTEES every OPEN error_events row + OPEN loop_alerts incident reaches a terminal state. Each pass it
// classifies every open signature against the live agent_jobs + fix-spec state:
//   (a) a fix already in-flight / merged-pending-deploy → CONFIRM, leave it (no action);
//   (b) no live repair job AND no authored fix spec → enqueueRepairJob so Rafa diagnoses + authors (then the
//       fix-escort auto-builds it) — the only routinely-new action;
//   (c) Rafa already authored a fix spec that's unbuilt → CONFIRM (the fix-escort / groom owns building it);
//   (d) the fix's build is STUCK (failed ≥ the loop-guard, nothing in-flight) → escalate the deeper issue.
// It REUSES the repair dedup (enqueueRepairJob is a no-op when a live repair job exists, and folds bursts into
// the cluster job) and adds its OWN fix-spec-coverage check so an authored-but-unbuilt fix is never
// re-diagnosed. Bounded per pass, idempotent, and DORMANT until Platform is live+autonomous — exactly like
// the escort + the enqueuer. A `reconciled_error` director_activity row is written per ACTION (enqueue /
// escalate), never per idle confirm. Net: the open-error count trends to zero on its own.
//
// Phase 2 (fix-error-reconcile-endless-loop) — cooldown + once-per-pass dedup. The dispose-on-completion
// of Phase 1 closes the row when the repair finishes; but a re-fire of the SAME signature before the
// fix deploys (recordError) re-opens the row (status→open, resolution_reason cleared) — so the very
// next pass scanned it as "open, no live repair, no fix spec" and enqueued a FRESH repair, which
// immediately short-circuited via `findAlreadyAddressing` and closed again. Net: ~12 pointless repair
// enqueues per signature per hour, burning the per-pass action cap and starving build initiation.
// The cooldown blocks that churn: a signature we already reconciled (or have a recent repair job for —
// live OR completed within the window) is SKIPPED this pass without burning a cap slot. The in-pass
// `handled` Set already guaranteed once-per-pass; the cooldown extends that across passes.
//
// NOT a coverage gap: the cooldown only delays the NEXT action on a signature — if the row is still
// open after the cooldown lapses, the next pass reconciles it fresh. So a genuinely-stuck error reaches
// Phase 3's loop-guard escalation on its own cadence; only the per-pass churn is gone.

/** Cap how many NEW reconcile ACTIONS (repair enqueues + stuck-fix escalations) one pass takes. */
export const PLATFORM_DIRECTOR_RECONCILE_CAP = 8;

/**
 * Cooldown window — a signature already reconciled (or with a repair job, live or recently completed)
 * within this is SKIPPED this pass without burning a cap slot. Sized to comfortably cover one
 * repair-diagnose → fix-spec-build → deploy cycle on the standing cadence (passes ~every 5 min), so the
 * SAME signature can't be re-enqueued 9-19× in an hour while the prior repair was still draining.
 * 30 min ⇒ at most ~2 reconcile actions per signature per hour even when the row keeps re-firing.
 */
export const PLATFORM_DIRECTOR_RECONCILE_COOLDOWN_MS = 30 * 60 * 1000;

/** One open backlog item the reconciler classifies — an error_events row OR a loop_alerts incident. */
interface OpenErrorItem {
  signature: string;
  source: string;
  title: string;
  errorEventId: string | null;
  loopAlertId: string | null;
}

/** The outcome of one backlog-reconcile pass — what it drove off the open feed. */
export interface ErrorBacklogReconcileResult {
  /** signatures with no coverage → a repair diagnosis we enqueued (case b). */
  enqueued: string[];
  /** fix specs whose build is stuck past the loop-guard → escalated to the CEO (case d). */
  escalated: string[];
  /** open errors already covered by a live repair job / authored fix spec — left alone (cases a/c). */
  confirmed: number;
  /** signatures in the cooldown window (recently reconciled OR a live/recent repair job) — skipped without burning a cap slot. */
  cooled: number;
  /** total open error_events + loop_alerts examined this pass. */
  scanned: number;
}

/**
 * Map every authored fix spec's Repair-signature(s) → its live SpecCard, so an open error already covered by
 * an authored fix is recognized (case a/c/d) and never re-diagnosed. Reads each repair-signed spec's markdown
 * and parses its `Repair-signature:` markers (the exact error_events signature / `loop:<id>` key Rafa stamped).
 */
async function fixSpecsBySignature(specs: SpecCard[]): Promise<Map<string, SpecCard>> {
  const bySig = new Map<string, SpecCard>();
  for (const card of specs) {
    if (!card.repairSignature) continue;
    const got = await getSpec(card.slug);
    if (!got) continue;
    for (const sig of parseRepairSpecMeta(got.raw).signatures) {
      if (!bySig.has(sig)) bySig.set(sig, card); // first (newest) wins; siblings group onto one spec anyway
    }
  }
  return bySig;
}

/**
 * Reconcile the OPEN error backlog: classify every open error_events row + open loop_alerts incident against
 * the live repair-job / fix-spec state and drive each toward a terminal state (enqueue a diagnosis where none
 * exists, confirm one that's covered, or escalate a stuck fix). Idempotent + bounded (PLATFORM_DIRECTOR_RECONCILE_CAP
 * new actions/pass), reuses the repair dedup, and a NO-OP until Platform is live+autonomous. Best-effort; the
 * caller logs the result.
 */
export async function reconcileErrorBacklog(admin: Admin): Promise<ErrorBacklogReconcileResult> {
  const empty: ErrorBacklogReconcileResult = { enqueued: [], escalated: [], confirmed: 0, cooled: 0, scanned: 0 };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty; // dormant until activation flips the flag

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return empty;

  // The open backlog — every OPEN error_events row + OPEN loop_alerts incident (global infra, not ws-scoped).
  const [{ data: errs }, { data: alerts }] = await Promise.all([
    admin.from("error_events").select("id, source, signature, title, status").eq("status", "open").order("last_seen_at", { ascending: false }).limit(200),
    admin.from("loop_alerts").select("id, loop_id, detail, status").eq("status", "open").order("last_seen_at", { ascending: false }).limit(200),
  ]);

  const items: OpenErrorItem[] = [];
  for (const e of (errs ?? []) as Array<{ id: string; source?: string; signature?: string; title?: string }>) {
    if (!e.signature) continue; // ungrouped rows can't be deduped — skip rather than misfire
    items.push({ signature: String(e.signature), source: String(e.source ?? "error"), title: String(e.title ?? e.signature), errorEventId: e.id, loopAlertId: null });
  }
  for (const a of (alerts ?? []) as Array<{ id: string; loop_id?: string; detail?: string }>) {
    if (!a.loop_id) continue;
    items.push({ signature: `loop:${a.loop_id}`, source: "loop-alert", title: `${a.loop_id}: ${a.detail ?? "loop red"}`.slice(0, 300), errorEventId: null, loopAlertId: a.id });
  }
  if (!items.length) return { ...empty, scanned: 0 };

  // Which open signatures already have an authored fix spec (so we confirm / escalate, never re-diagnose).
  const { specs } = await getRoadmap();
  const fixBySig = await fixSpecsBySignature(specs);

  // Phase 2 cooldown ledger — a signature we already acted on within PLATFORM_DIRECTOR_RECONCILE_COOLDOWN_MS,
  // OR has a repair job (live OR completed/failed within the window), is in cooldown: SKIP this pass without
  // burning a cap slot. Two sources, OR'd:
  //   • prior `reconciled_error` director_activity rows → we already enqueued/escalated; the action is still
  //     in-flight, re-firing now would just churn.
  //   • repair agent_jobs touched within the window → covers the case where the row keeps re-opening via
  //     recordError after a repair already diagnosed it (the "stale-error trap" the loop was caused by).
  // The window comfortably spans one diagnose→build→deploy cycle, so a signature consumes at most ~2 cap
  // slots per hour even when its row keeps re-firing — that's what restores the standing pass's build budget.
  const cooldownSinceIso = new Date(Date.now() - PLATFORM_DIRECTOR_RECONCILE_COOLDOWN_MS).toISOString();
  const [{ data: cooldownActs }, { data: recentRepairs }] = await Promise.all([
    admin
      .from("director_activity")
      .select("metadata")
      .eq("director_function", PLATFORM)
      .eq("action_kind", "reconciled_error")
      .gte("created_at", cooldownSinceIso),
    admin
      .from("agent_jobs")
      .select("spec_slug")
      .eq("kind", "repair")
      .gte("created_at", cooldownSinceIso),
  ]);
  const cooledSigs = new Set<string>();
  for (const a of (cooldownActs ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
    const sig = typeof a.metadata?.signature === "string" ? (a.metadata.signature as string) : null;
    if (sig) cooledSigs.add(sig);
  }
  for (const j of (recentRepairs ?? []) as Array<{ spec_slug?: string | null }>) {
    if (j.spec_slug) cooledSigs.add(String(j.spec_slug));
  }

  const enqueued: string[] = [];
  const escalated: string[] = [];
  let confirmed = 0;
  let cooled = 0;

  // Dedup repeated signatures within this same pass (an error + its sibling loop alert can collide); the cap
  // bounds NEW actions (enqueues + escalations) — idle confirms are cheap and always counted.
  const handled = new Set<string>();
  for (const item of items) {
    if (handled.has(item.signature)) continue;
    handled.add(item.signature);
    // Phase 2 cooldown — a signature already reconciled (or with a live/recent repair job) within the
    // window is SKIPPED. The prior action is still draining; re-acting now would just burn another cap slot
    // and starve build initiation. Skipping doesn't lose coverage — when the cooldown lapses, the next pass
    // reconciles a still-open row fresh, and a genuinely-stuck error reaches Phase 3's loop-guard on cadence.
    if (cooledSigs.has(item.signature)) {
      cooled++;
      continue;
    }
    const atCap = enqueued.length + escalated.length >= PLATFORM_DIRECTOR_RECONCILE_CAP;

    const coverSpec = fixBySig.get(item.signature);
    if (coverSpec) {
      // (a) merged-pending-deploy — the fix shipped; the error stays open only until the deploy lands. Leave it.
      if (coverSpec.status === "shipped") {
        confirmed++;
        continue;
      }
      const state = await specBuildState(admin, workspaceId, coverSpec.slug);
      // (d) the fix's build is STUCK past the loop-guard with nothing in-flight → a deeper issue, not a flaky
      // retry. Escalate to the CEO (deduped on the SAME `loopguard:<slug>` key the fix-escort uses, so the two
      // lanes never double-ping). The fix-escort owns RE-QUEUING; the reconciler just guarantees it's surfaced.
      if (!state.inFlight && state.failedCount >= PLATFORM_DIRECTOR_LOOP_GUARD_MAX) {
        if (atCap) continue; // bounded — pick it up next pass
        const diagnosis = `Open error \`${item.signature}\` is covered by fix spec "${coverSpec.slug}", but its build failed ${state.failedCount}× without landing — likely a deeper issue, not a flaky retry${state.lastError ? ` (latest: ${state.lastError.slice(0, 300)})` : ""}. I've stopped resubmitting; approve modifying the spec/approach and I'll carry it from there.`;
        const r = await escalateDiagnosisToCeo(admin, {
          workspaceId,
          specSlug: coverSpec.slug,
          title: `Build stuck: ${coverSpec.slug}`,
          diagnosis,
          dedupeKey: `loopguard:${coverSpec.slug}`,
          deepLink: `/dashboard/roadmap/${coverSpec.slug}`,
          escalationKind: "loop_guard",
          metadata: { kind: "reconcile", signature: item.signature, failed_attempts: state.failedCount, last_error: state.lastError ?? undefined },
        });
        if (r.emitted) {
          escalated.push(coverSpec.slug);
          await recordDirectorActivity(admin, {
            workspaceId,
            directorFunction: PLATFORM,
            actionKind: "reconciled_error",
            specSlug: coverSpec.slug,
            reason: diagnosis,
            metadata: { signature: item.signature, source: item.source, action: "escalated_stuck", error_event_id: item.errorEventId, loop_alert_id: item.loopAlertId, autonomous: true },
          });
        } else if (r.error) {
          console.error(`[platform-director] reconcile CEO escalation FAILED to surface (loopguard:${coverSpec.slug}): ${r.error.message}`);
        }
        continue;
      }
      // (c) authored fix spec, in-flight or awaiting its build → the fix-escort / groom owns driving it. Confirm.
      confirmed++;
      continue;
    }

    // (b) no authored fix spec — does a live repair JOB already cover it? enqueueRepairJob is the dedup: it
    // no-ops (or folds into the cluster job) when one exists, and enqueues a fresh diagnosis when none does.
    if (atCap) continue; // bounded — the backlog re-drives next pass; nothing is lost
    const r = await enqueueRepairJob(admin, {
      source: item.source,
      signature: item.signature,
      title: item.title,
      errorEventId: item.errorEventId,
      loopAlertId: item.loopAlertId,
    });
    if (r.enqueued) {
      enqueued.push(item.signature);
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM,
        actionKind: "reconciled_error",
        specSlug: null,
        reason: `Backlog item \`${item.signature}\` (${item.source}) had no live repair job and no fix spec — enqueued a repair diagnosis so Rafa authors a fix (then the fix-escort builds it).`,
        metadata: { signature: item.signature, source: item.source, action: "enqueued_repair", error_event_id: item.errorEventId, loop_alert_id: item.loopAlertId, autonomous: true },
      });
    } else {
      // a live repair job already exists / folded into the cluster — already being diagnosed. Confirm.
      confirmed++;
    }
  }

  return { enqueued, escalated, confirmed, cooled, scanned: handled.size };
}

// ── regression-backlog-reconciliation Phase 1 — standing re-verification sweep (close the coverage gap) ──
// The regression-side sibling of reconcileErrorBacklog. Remi (the regression-agent) is purely EVENT-driven:
// `enqueueRegressionJob` only fires when a spec-test run happens to re-test a shipped spec and finds a `fail`.
// Nothing GUARANTEES every shipped spec is periodically re-verified, so a silent regression can sit in a
// shipped feature forever (Remi fired ZERO times — 0 regression jobs). Coverage is the Director's job: each
// standing pass this picks the SHIPPED, unarchived specs LEAST-recently verified (oldest spec_test_runs first)
// and enqueues a Vera spec-test re-run for them — so a silent regression is caught even when nothing
// event-triggered a re-test. An `issues` result flows to Remi through the EXISTING `enqueueRegressionJob`
// (the `runSpecTestJob` tail), so this adds NO new detector — only the standing coverage guarantee.
//
// Bounded + idempotent: a spec re-verified within the freshness window is SKIPPED (no churn); the shared
// `enqueueSpecTestIfDue` chokepoint then guards the double-queue (it no-ops a (workspace, slug) with an
// in-flight spec-test job or a fresh ~20h run, and re-asserts the spec is still shipped). NO-OP until
// Platform is live+autonomous, like every other standing lane. Best-effort; the caller logs the result.

/** Cap how many least-recently-verified shipped specs one re-verification sweep enqueues (the groom-cap analogue). */
export const PLATFORM_DIRECTOR_REVERIFY_CAP = 8;

/** Freshness window: a shipped spec re-verified within this is skipped (no churn). Mirrors the regression-agent's 7d. */
export const PLATFORM_DIRECTOR_REVERIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** The outcome of one re-verification sweep — what coverage it topped up this pass. */
export interface RegressionCoverageResult {
  /** shipped specs we enqueued a spec-test re-run for (an `issues` result flows to Remi via enqueueRegressionJob). */
  queued: string[];
  /** shipped specs skipped because they were verified within the freshness window (no churn). */
  skippedFresh: number;
  /** total shipped, unarchived specs considered this pass. */
  scanned: number;
}

/**
 * One standing re-verification sweep: enqueue a spec-test re-run for the SHIPPED, unarchived specs least-recently
 * verified (oldest spec_test_runs first; a never-verified spec sorts oldest), skipping any verified within the
 * freshness window, capped per pass. Closes the coverage gap so a silent regression is caught even when nothing
 * event-triggered a re-test — the `issues` result then flows to Remi through the existing `enqueueRegressionJob`.
 */
export async function reconcileRegressionCoverage(admin: Admin): Promise<RegressionCoverageResult> {
  const empty: RegressionCoverageResult = { queued: [], skippedFresh: 0, scanned: 0 };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty; // dormant until activation flips the flag

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return empty;

  // The coverage universe — shipped-but-not-archived specs (the SAME set the spec-test cron sweeps).
  const [{ specs }, archived] = await Promise.all([getRoadmap(), listArchivedSlugs()]);
  const archivedSet = new Set(archived);
  const shipped = specs.filter((s) => s.status === "shipped" && !archivedSet.has(s.slug));
  if (!shipped.length) return empty;

  // The latest spec-test run per slug → its run_at (newest first, so the first seen per slug wins). A spec with
  // NO run was never verified → it sorts oldest (epoch), so it's picked first.
  const slugs = shipped.map((s) => s.slug);
  const { data: runs } = await admin
    .from("spec_test_runs")
    .select("spec_slug, run_at")
    .eq("workspace_id", workspaceId)
    .in("spec_slug", slugs)
    .order("run_at", { ascending: false })
    .limit(2000);
  const latestRunMs = new Map<string, number>();
  for (const r of (runs ?? []) as Array<{ spec_slug?: string; run_at?: string }>) {
    const slug = String(r.spec_slug ?? "");
    if (!slug || latestRunMs.has(slug)) continue; // first (newest) wins
    latestRunMs.set(slug, r.run_at ? Date.parse(String(r.run_at)) : 0);
  }

  // Candidates = never-verified OR last-verified before the freshness window; the rest are skipped (no churn).
  const freshCutoff = Date.now() - PLATFORM_DIRECTOR_REVERIFY_WINDOW_MS;
  const candidates: Array<{ slug: string; lastVerifiedMs: number }> = [];
  let skippedFresh = 0;
  for (const card of shipped) {
    const lastVerifiedMs = latestRunMs.get(card.slug) ?? 0; // 0 = never verified (oldest)
    if (lastVerifiedMs && lastVerifiedMs >= freshCutoff) {
      skippedFresh++;
      continue;
    }
    candidates.push({ slug: card.slug, lastVerifiedMs });
  }
  candidates.sort((a, b) => a.lastVerifiedMs - b.lastVerifiedMs); // least-recently-verified first

  const queued: string[] = [];
  for (const c of candidates) {
    if (queued.length >= PLATFORM_DIRECTOR_REVERIFY_CAP) break;
    // Reuse the shared chokepoint: it re-asserts the spec is shipped, dedups an in-flight spec-test job, and
    // skips a fresh (~20h) run — so we never double-queue and never pile up the spec-test lane.
    const { enqueued } = await enqueueSpecTestIfDue(workspaceId, c.slug, "shipped");
    if (enqueued) queued.push(c.slug);
  }

  if (queued.length) {
    const windowDays = Math.round(PLATFORM_DIRECTOR_REVERIFY_WINDOW_MS / (24 * 60 * 60 * 1000));
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: PLATFORM,
      actionKind: "reconciled_coverage",
      specSlug: queued[0],
      reason: `Standing re-verification sweep: ${queued.length} shipped spec(s) not re-verified within ${windowDays}d → queued a spec-test re-run so a silent regression is caught (an \`issues\` result flows to Remi via the existing regression trigger) — ${queued.join(", ")}.`,
      metadata: { queued, skipped_fresh: skippedFresh, scanned: shipped.length, autonomous: true },
    });
  }

  return { queued, skippedFresh, scanned: shipped.length };
}

// ── regression-backlog-reconciliation Phase 2 — drive every regression to a terminal state ──────────────
// The standing-coverage sweep (Phase 1) GUARANTEES a silent regression is DETECTED (a shipped spec gets re-
// verified on a cadence, an `issues` result flows to Remi). This is the other half — the mirror of
// reconcileErrorBacklog for the regression surface: GUARANTEE every detected regression reaches a TERMINAL
// state (reviewed → dismissed / authored-and-built / escalated). The gap: a shipped spec with an UNRESOLVED
// evidence-backed spec-test `fail` (the getHumanTestQueue regression definition) but NO live `regression` job
// — a break that was detected but never dispositioned (a regression job that slipped its enqueue, a fix that
// didn't hold and the re-fire never re-queued, or a fail recorded while Platform was dormant). Each pass it
// classifies every unresolved regression against the live regression-job + authored-fix state:
//   (a) a live regression review OR an authored fix that's in-flight / merged-pending-deploy → CONFIRM, leave it;
//   (b) no live review AND under the loop-guard → enqueueRegressionJob so Remi reviews it (the routine new action);
//   (c) Remi authored fixes that repeatedly DIDN'T hold (≥ REGRESSION_LOOP_GUARD_MAX) with nothing in-flight →
//       escalate the deeper issue to the CEO (deduped) instead of re-authoring forever (Remi's loop-guard).
// REUSES the existing chokepoints: enqueueRegressionJob is the dedup (no-op on a live job / a no-resurface
// dismissal), and the loop-guard count mirrors regressionAuthoredAttempts. Bounded per pass, idempotent, and
// DORMANT until Platform is live+autonomous — exactly like the error-backlog reconcile. A `reconciled_regression`
// director_activity row is written per ACTION (enqueue / escalate), never per idle confirm. Best-effort.

/** Cap how many NEW reconcile ACTIONS (regression enqueues + stuck-fix escalations) one pass takes. */
export const PLATFORM_DIRECTOR_REGRESSION_RECONCILE_CAP = 8;

/** The outcome of one regression-backlog-reconcile pass — what it drove off the unresolved-regression feed. */
export interface RegressionBacklogReconcileResult {
  /** specs with an unresolved fail + no live review → a regression review we enqueued for Remi (case b). */
  enqueued: string[];
  /** specs whose authored fix repeatedly failed past the loop-guard → escalated to the CEO (case c). */
  escalated: string[];
  /** unresolved regressions already covered by a live review / an in-flight-or-landed fix — left alone (case a). */
  confirmed: number;
  /** total shipped specs with an unresolved evidence-backed spec-test fail examined this pass. */
  scanned: number;
}

/**
 * The live regression-disposition state for ONE shipped spec: is a review live (or a fix in-flight / landed),
 * how many authored fix attempts didn't hold (the loop-guard count), and the latest fix-build failure. Reads
 * the recent `regression` jobs for the spec (matched on `instructions.spec_slug`, since the row's spec_slug
 * column holds the SIGNATURE) + the build state of every fix slug Remi authored. The reconciler uses this to
 * pick confirm (in-flight) · enqueue (no review, under the cap) · escalate (stuck past the loop-guard).
 */
async function regressionDispositionState(
  admin: Admin,
  workspaceId: string,
  specSlug: string,
): Promise<{ liveReview: boolean; fixInFlight: boolean; authoredAttempts: number; lastError: string | null }> {
  const sinceIso = new Date(Date.now() - REGRESSION_RECENT_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("agent_jobs")
    .select("status, instructions")
    .eq("kind", "regression")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(500);
  let liveReview = false;
  let authoredAttempts = 0;
  const authoredSlugs = new Set<string>();
  for (const r of (data ?? []) as Array<{ status?: string; instructions?: string }>) {
    let instr: RegressionInstructions;
    try {
      instr = JSON.parse(String(r.instructions || "{}")) as RegressionInstructions;
    } catch {
      continue;
    }
    if (instr.spec_slug !== specSlug) continue;
    if (LIVE_REGRESSION_STATUSES.includes(String(r.status ?? ""))) liveReview = true;
    if (instr.authored_slug) {
      authoredAttempts++;
      authoredSlugs.add(instr.authored_slug);
    }
  }
  // Is any authored fix spec actively building or already landed (merged-pending-deploy)? A landed fix still
  // shows the unresolved fail until the re-deploy + the next spec-test re-run clears it (Phase 1) — so an
  // in-flight OR landed fix suppresses both a re-enqueue and the loop-guard escalation (it IS progressing).
  let fixInFlight = false;
  let lastError: string | null = null;
  for (const slug of authoredSlugs) {
    const state = await specBuildState(admin, workspaceId, slug);
    if (state.inFlight) fixInFlight = true;
    if (lastError === null && state.lastError) lastError = state.lastError;
  }
  return { liveReview, fixInFlight, authoredAttempts, lastError };
}

/**
 * Reconcile the unresolved-regression backlog: classify every shipped spec carrying an unresolved evidence-
 * backed spec-test `fail` (the getHumanTestQueue regression definition) against the live regression-job +
 * authored-fix state and drive each toward terminal — enqueue a review where none exists, confirm one that's
 * covered, or escalate a fix stuck past the loop-guard. Idempotent + bounded
 * (PLATFORM_DIRECTOR_REGRESSION_RECONCILE_CAP new actions/pass), reuses the regression dedup, and a NO-OP until
 * Platform is live+autonomous. Best-effort; the caller logs the result.
 */
export async function reconcileRegressionBacklog(admin: Admin): Promise<RegressionBacklogReconcileResult> {
  const empty: RegressionBacklogReconcileResult = { enqueued: [], escalated: [], confirmed: 0, scanned: 0 };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty; // dormant until activation flips the flag

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return empty;

  // The unresolved-regression feed — shipped specs whose latest spec-test run has ≥1 evidence-backed `fail`
  // the owner hasn't dismissed/resolved (the SAME definition the human-test queue + the regression banner read).
  const { regressions } = await getHumanTestQueue(workspaceId);
  if (!regressions.length) return empty;

  const enqueued: string[] = [];
  const escalated: string[] = [];
  let confirmed = 0;

  // Dedup specs within this pass (a spec surfaces once per run, but guard anyway); the cap bounds NEW actions
  // (enqueues + escalations) — idle confirms are cheap and always counted.
  const handled = new Set<string>();
  for (const reg of regressions) {
    if (handled.has(reg.slug)) continue;
    handled.add(reg.slug);
    const failing = (reg.failing || []).filter((f) => f && f.check_key);
    if (!failing.length) continue; // no evidence-backed failing check → nothing Remi can dedup on
    const atCap = enqueued.length + escalated.length >= PLATFORM_DIRECTOR_REGRESSION_RECONCILE_CAP;

    const state = await regressionDispositionState(admin, workspaceId, reg.slug);

    // (a) a live review OR an authored fix that's in-flight / merged-pending-deploy → it's being dispositioned.
    // Confirm and leave it — don't re-enqueue a review for a break that's already moving toward terminal.
    if (state.liveReview || state.fixInFlight) {
      confirmed++;
      continue;
    }

    // (c) Remi authored fixes that repeatedly DIDN'T hold (the break keeps re-firing) and nothing is in-flight →
    // a deeper issue, not a flaky retry. Escalate to the CEO (deduped on `regression-loopguard:<slug>`) instead
    // of re-enqueuing a review forever — Remi's loop-guard, applied at the reconcile layer.
    if (state.authoredAttempts >= REGRESSION_LOOP_GUARD_MAX) {
      if (atCap) continue; // bounded — pick it up next pass
      const diagnosis = `Regression on shipped spec "${reg.slug}" keeps re-firing — Remi authored ${state.authoredAttempts} fix(es) that didn't hold, and nothing is in-flight${state.lastError ? ` (latest fix-build error: ${state.lastError.slice(0, 300)})` : ""}. The failing checks: ${failing.map((f) => f.text).join("; ")}. I've stopped re-authoring; approve a deeper change to the spec/approach and I'll carry it from there.`;
      const r = await escalateDiagnosisToCeo(admin, {
        workspaceId,
        specSlug: reg.slug,
        title: `Regression stuck: ${reg.slug}`,
        diagnosis,
        dedupeKey: `regression-loopguard:${reg.slug}`,
        deepLink: `/dashboard/roadmap/${reg.slug}`,
        escalationKind: "loop_guard",
        metadata: { kind: "regression", failed_attempts: state.authoredAttempts, last_error: state.lastError ?? undefined },
      });
      if (r.emitted) {
        escalated.push(reg.slug);
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: PLATFORM,
          actionKind: "reconciled_regression",
          specSlug: reg.slug,
          reason: diagnosis,
          metadata: { signature: regressionSignature(reg.slug, failing.map((f) => f.check_key)), action: "escalated_stuck", failed_attempts: state.authoredAttempts, last_error: state.lastError ?? undefined, autonomous: true },
        });
      } else if (r.error) {
        console.error(`[platform-director] regression reconcile CEO escalation FAILED to surface (regression-loopguard:${reg.slug}): ${r.error.message}`);
      }
      continue;
    }

    // (b) the gap: an unresolved regression with no live review, under the loop-guard → enqueue Remi. The shared
    // enqueueRegressionJob is the chokepoint: it no-ops on a live job / a no-resurface dismissal (then we confirm),
    // and writes its own `detected_regression` row + dedups on the signature, so we never double-review a break.
    if (atCap) continue; // bounded — the backlog re-drives next pass; nothing is lost
    const r = await enqueueRegressionJob(admin, {
      workspaceId,
      specSlug: reg.slug,
      title: reg.title,
      failing,
      runAt: reg.run_at,
    });
    if (r.enqueued) {
      enqueued.push(reg.slug);
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM,
        actionKind: "reconciled_regression",
        specSlug: reg.slug,
        reason: `Unresolved regression on shipped spec ${reg.slug} (${failing.length} failing check(s)) had no live regression review — enqueued Remi to disposition it (review → dismiss / author a fix).`,
        metadata: { signature: r.reason, action: "enqueued_regression", failing: failing.map((f) => ({ text: f.text, check_key: f.check_key })), run_at: reg.run_at, autonomous: true },
      });
    } else {
      // a live review formed since the state read, or this exact break was already dismissed (no re-surface) →
      // it's covered. Confirm.
      confirmed++;
    }
  }

  return { enqueued, escalated, confirmed, scanned: handled.size };
}

// ── needs-attention-triage-and-verdict-robustness Phase 1 — triage every NON-build needs_attention item ──
// The build loop-guard (FAILED_BUILD_STATUSES → specBuildState, which queries kind='build') only treats a
// `needs_attention` as a failed attempt for kind='build' jobs. A `needs_attention` on a NON-build QC job
// (security-review / spec-test / regression / proposed-goal / greenlight commit failure) is triaged by
// NOTHING — it just SITS (the 2026-06-24 director-executable-plans security-review that parked with "ended
// without a recognizable verdict" and nobody handled). This standing reconciler is the backstop: each pass it
// classifies every parked NON-build item and either RE-RUNS a RECOVERABLE one (an inconclusive/unparseable QC
// verdict — re-queue the same job; it re-investigates from `instructions` and is re-dispatched by kind) ONCE,
// or SURFACES a HUMAN-NEEDED blocker to the CEO with a CLEAR diagnosis (the reason + an excerpt — never a bare
// "needs attention"). Loop-guarded (a re-run that parks AGAIN escalates, never churns), deduped per job (a
// `triaged_needs_attention` director_activity row per action), bounded per pass, and DORMANT until Platform is
// live+autonomous — like every other standing lane. Conservative fail-safe: only a clearly-recoverable QC
// inconclusive is auto-re-run; everything else surfaces to the human (never a silent pass).
//
// NOT double-handled: kind='build' is the existing build loop-guard's; kind='repair' is superviseRepairDismissals'
// (it adversarially re-checks every repair needs_attention item); the director's OWN jobs are skipped.

/** Cap how many NEW triage ACTIONS (re-runs + CEO escalations) one pass takes. */
export const PLATFORM_DIRECTOR_TRIAGE_CAP = 8;

/** Kinds another director lane already owns — never double-handle a parked item of these kinds. */
const TRIAGE_SKIP_KINDS: ReadonlySet<string> = new Set(["build", "repair", "platform-director"]);

/** QC kinds whose handler re-investigates cleanly from `instructions`, so a recoverable park can be re-run. */
const TRIAGE_RERUNNABLE_KINDS: ReadonlySet<string> = new Set(["security-review", "spec-test", "regression"]);

/** A recoverable park: an inconclusive / unparseable QC verdict (a transient failure to produce a verdict). */
const TRIAGE_RECOVERABLE_ERROR = /no parseable verdict|without a recognizable (verdict|status)|inconclusive/i;

/** The outcome of one needs_attention triage pass — what it drove off the parked feed. */
export interface NeedsAttentionReconcileResult {
  /** parked items re-run once (a recoverable inconclusive QC result). */
  rerun: string[];
  /** parked items surfaced to the CEO with a diagnosis (a genuine blocker, or a re-run that parked again). */
  escalated: string[];
  /** parked items left as-is (already triaged a prior pass — deduped). */
  confirmed: number;
  /** total non-build, non-repair parked items examined this pass. */
  scanned: number;
}

/**
 * Triage every NON-build `needs_attention` agent_job: re-run a recoverable inconclusive QC result ONCE, or
 * surface a genuine blocker to the CEO with a clear reason + excerpt. Loop-guarded (a re-run that parks again
 * escalates, never re-run twice), deduped per job (a `triaged_needs_attention` director_activity row per
 * action), bounded per pass (PLATFORM_DIRECTOR_TRIAGE_CAP), and a NO-OP until Platform is live+autonomous.
 * Best-effort; the caller logs the result.
 */
export async function reconcileNeedsAttention(admin: Admin): Promise<NeedsAttentionReconcileResult> {
  const empty: NeedsAttentionReconcileResult = { rerun: [], escalated: [], confirmed: 0, scanned: 0 };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty; // dormant until activation flips the flag

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return empty;

  // Every parked item NOT owned by the build loop-guard / the repair-dismissal lane / the director itself.
  const { data: parked } = await admin
    .from("agent_jobs")
    .select("id, kind, status, error, log_tail, spec_slug, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "needs_attention")
    .order("created_at", { ascending: false })
    .limit(200);
  const items = ((parked ?? []) as Array<{ id: string; kind: string; error?: string | null; log_tail?: string | null; spec_slug?: string | null }>)
    .filter((j) => !TRIAGE_SKIP_KINDS.has(String(j.kind)));
  if (!items.length) return empty;

  // The triage ledger — every `triaged_needs_attention` row carries `metadata.job_id` + `metadata.action`
  // (rerun | escalated). A job already escalated is left (deduped); a job re-run once is the loop-guard input.
  const { data: acts } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("director_function", PLATFORM)
    .eq("action_kind", "triaged_needs_attention")
    .order("created_at", { ascending: false })
    .limit(1000);
  const reran = new Set<string>();
  const surfaced = new Set<string>();
  for (const a of acts ?? []) {
    const m = (a.metadata as Record<string, unknown> | null) ?? {};
    const jid = typeof m.job_id === "string" ? m.job_id : null;
    if (!jid) continue;
    if (m.action === "escalated") surfaced.add(jid);
    else if (m.action === "rerun") reran.add(jid);
  }

  const rerun: string[] = [];
  const escalated: string[] = [];
  let confirmed = 0;

  for (const j of items) {
    // Already surfaced to the CEO a prior pass — leave it for the human (deduped, no churn).
    if (surfaced.has(j.id)) { confirmed++; continue; }
    const atCap = rerun.length + escalated.length >= PLATFORM_DIRECTOR_TRIAGE_CAP;

    const kind = String(j.kind);
    const error = String(j.error ?? "").trim();
    const excerpt = String(j.log_tail ?? "").trim().slice(-400) || error || "(no detail)";
    const specSlug = (j.spec_slug as string | null) ?? null;
    const deepLink = specSlug ? `/dashboard/roadmap/${specSlug}` : `/dashboard/developer/control-tower`;
    const recoverable = TRIAGE_RECOVERABLE_ERROR.test(error) && TRIAGE_RERUNNABLE_KINDS.has(kind);
    const alreadyReran = reran.has(j.id);

    // RECOVERABLE + not yet re-run → re-run the QC step ONCE. Re-queue the same job (claim_agent_job re-claims
    // `queued`; the handler re-investigates from `instructions` and is re-dispatched by kind). Loop-guarded: a
    // re-run that parks AGAIN falls through to escalation below (alreadyReran), never re-run twice.
    if (recoverable && !alreadyReran) {
      if (atCap) continue; // bounded — re-drives next pass; nothing is lost
      // Re-assert it's still parked (never clobber an item a human / another lane just moved).
      const { data: fresh } = await admin.from("agent_jobs").select("status").eq("id", j.id).maybeSingle();
      if ((fresh as { status?: string } | null)?.status !== "needs_attention") { confirmed++; continue; }
      const { error: upErr } = await admin
        .from("agent_jobs")
        .update({ status: "queued", claimed_at: null, error: null, log_tail: `re-run by director triage (recoverable: ${error.slice(0, 200)})`.slice(-2000) })
        .eq("id", j.id);
      if (upErr) { console.error(`[platform-director] triage re-run FAILED (${j.id.slice(0, 8)}): ${upErr.message}`); continue; }
      rerun.push(`${kind}:${j.id.slice(0, 8)}`);
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM,
        actionKind: "triaged_needs_attention",
        specSlug,
        reason: `A ${kind} job parked with an inconclusive QC result ("${error.slice(0, 200)}") — re-ran it once (recoverable). If it parks again I'll surface it to you.`,
        metadata: { job_id: j.id, target_kind: kind, action: "rerun", error, autonomous: true },
      });
      continue;
    }

    // HUMAN-NEEDED (a genuine blocker) OR a re-run that parked AGAIN (loop-guard) → surface to the CEO with a
    // CLEAR diagnosis (the reason + an excerpt), never a bare flag. Conservative: anything not a clearly-
    // recoverable QC inconclusive lands here.
    if (atCap) continue; // bounded — re-drives next pass
    // one-card-per-park (DEDUP): if ANOTHER park surface (the backstop "Park needs eyes", the >70-min
    // age alarm, or a prior tick's card) already has an active card for this job, don't add a second.
    // A single parked job must surface AT MOST ONE CEO card. escalateDiagnosisToCeo also dedupes on its
    // own `needsattn:` key, but that wouldn't catch a sibling emitter's differently-keyed card.
    if (await activeParkCardExistsForJob(admin, workspaceId, j.id)) { confirmed++; continue; }
    const why = alreadyReran
      ? "re-ran once after an inconclusive QC result and parked AGAIN — likely a real blocker, not a transient"
      : recoverable
        ? "parked with an inconclusive QC result that couldn't be auto-recovered"
        : "parked and nothing automated can resolve it";
    const diagnosis = `A ${kind} job is parked in needs_attention: it ${why}. Reason: ${error || "(none recorded)"}. Detail: ${excerpt}`.slice(0, 4000);
    // Per-PR escalation dedupe (pr-resolve storm fix, 2026-07-03): every parked pr-resolve job for one PR
    // shares `spec_slug` = `pr-<n>`, so key the CEO card on the PR (spec_slug) rather than the job id — N
    // retries against a superseded/un-mergeable PR collapse to ONE inbox card instead of one per job (two
    // superseded PRs had produced 11+ near-identical "Parked pr-resolve" cards). Other kinds stay per-job.
    const parkDedupeKey = kind === "pr-resolve" && specSlug ? `needsattn:${specSlug}` : `needsattn:${j.id}`;
    const r = await escalateDiagnosisToCeo(admin, {
      workspaceId,
      specSlug,
      title: `Parked ${kind}${specSlug ? `: ${specSlug}` : ""}`,
      diagnosis,
      dedupeKey: parkDedupeKey,
      deepLink,
      escalationKind: "needs_attention",
      metadata: { kind: "needs_attention_triage", job_id: j.id, target_kind: kind, error, loop_guard: alreadyReran },
    });
    if (r.emitted) {
      escalated.push(`${kind}:${j.id.slice(0, 8)}`);
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM,
        actionKind: "triaged_needs_attention",
        specSlug,
        reason: diagnosis,
        metadata: { job_id: j.id, target_kind: kind, action: "escalated", error, loop_guard: alreadyReran, autonomous: true },
      });
    } else if (r.error) {
      console.error(`[platform-director] triage CEO escalation FAILED to surface (needsattn:${j.id.slice(0, 8)}): ${r.error.message}`);
    } else {
      // notification already exists (dedup) but no triage row yet — count as surfaced so we don't reprocess.
      confirmed++;
    }
  }

  return { rerun, escalated, confirmed, scanned: items.length };
}

// ── Phase 3 (goal-milestone-build-sequencing) — re-sequence an out-of-order milestone fan-out ──────
// A goal is a DAG of milestones: building them concurrently without deps corrupts the build (a later spec
// references an earlier one's outputs). When the decomposition emits a goal whose milestone specs lack the
// `**Blocked-by:**` line that staggers them (the 2026-06-24 03:45 incident), the milestone builds fan out
// CONCURRENTLY and the dependents jam — stuck in needs_input/needs_approval for prerequisites that don't
// exist yet. This standing reconciler is the recovery + the standing guard: it detects each milestone build
// that fanned out before its prerequisites, HOLDS the premature build (cancels the unapprovable fan-out),
// applies the AUTHORED `Blocked-by` order (transcribed from the goal doc — NEVER a guessed DAG), and lets the
// existing reactive auto-queue (`autoQueueUnblockedBy`) + the goal escort re-release it once its blockers ship.
//
// The order is NOT inferred: Pia ([[goal-decomposition-engine]]) writes the build order into the goal's
// milestone list as a `*(blocked by [[../specs/x]])*` annotation per spec; this reconcile transcribes that
// CEO-greenlit order onto the spec file's `**Blocked-by:**` line — the enforcement point the spec-blockers
// chokepoint reads. So it only ever enforces a sequence the operator already approved, hitting the north star
// (a DAG ordering is the CEO's call — the reconcile applies it, it does not author one).
//
// Idempotent on three fronts: it only acts on a spec whose file is MISSING a declared blocker (once the line
// is written the spec is no longer a candidate), only on a spec with an ACTIVE build (once held the job leaves
// the active set), and dedups on a recent `reconciled_sequence` ledger row (so the box's bundled fs lagging
// `main` can't trigger a re-write). Bounded per pass; DORMANT until Platform is live+autonomous, like every
// other lane. Writes one `reconciled_sequence` [[../tables/director_activity]] row per re-sequenced build.

/** Cap how many out-of-order milestone builds one reconcile pass re-sequences. */
export const PLATFORM_DIRECTOR_SEQUENCE_CAP = 8;

/**
 * The status the reconcile parks a premature milestone build at — it CANCELS the out-of-order fan-out so the
 * job leaves needs_input/needs_approval (no longer jammed/unapprovable). `claim_agent_job` only claims
 * `queued`/`queued_resume`, so a `held` job is never re-run; {@link specBuildState} ignores it (neither active
 * nor a failure), so the goal escort re-releases the spec FRESH once its newly-applied blockers clear.
 */
export const SEQUENCE_HELD_STATUS = "held";

/** One out-of-order milestone build the sequence reconcile recovers. */
export interface MilestoneSequenceViolation {
  /** the milestone spec that built (or is building) before its prerequisites. */
  slug: string;
  goalSlug: string;
  goalTitle: string;
  /** the premature build job to HOLD. */
  jobId: string;
  /** the status it was held FROM (queued/building/needs_input/needs_approval/queued_resume). */
  jobStatus: string;
  /** every blocker the goal doc declares for this spec (the authored order). */
  declaredBlockers: string[];
  /** declared blockers not yet shipped — why this build shouldn't have started. */
  unmetBlockers: string[];
  /** declared blockers absent from the spec's OWN `**Blocked-by:**` line — the blocker-less-fan-out bug. */
  missingFromFile: string[];
}

/** The outcome of one read-only sequence-violation scan. */
export interface SequenceReconcileResult {
  /** out-of-order milestone builds detected (the box lane holds them + applies the Blocked-by line). */
  violations: MilestoneSequenceViolation[];
  /** goal-member dependent specs (declared blockers, unmet, missing from file) examined this pass. */
  scanned: number;
}

/** Extract the spec-link slugs in a blob ([[../specs/x]] / [[x]]; goals/functions/lifecycles excluded). */
function specLinkSlugs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = m[1].trim();
    if (/\//.test(target) && !/(^|\/)specs\//.test(target)) continue; // a goal/function/etc. link, not a spec
    out.push(target.replace(/^.*\//, "").replace(/\.md$/, ""));
  }
  return out;
}

/**
 * Parse a goal doc's per-milestone-spec dependency annotations → `specSlug → declared blocker slugs`. Pia
 * writes the build order in the goal's milestone list as a `*(blocked by [[../specs/x]], [[../specs/y]])*` (or
 * `*(blocked_by [])*` for a foundation) annotation on each spec's bullet. This TRANSCRIBES that authored order
 * — it never infers one: a line's first spec link (before the "blocked by" marker) is the milestone spec, and
 * the spec links AFTER the marker are its declared blockers. A bullet with no `blocked by` marker (a
 * foundation) yields no entry — correctly leaving it un-blocked. Exported for the box lane + tests.
 */
export function parseGoalSpecBlockers(rawGoalMd: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of rawGoalMd.split("\n")) {
    // The authored annotation is bounded to its `*( … )*` parenthetical — `*(blocked by [[x]], [[y]])*`, or
    // `*(foundation — blocked_by [])*`. Bound blocker extraction to INSIDE the parenthetical so an unrelated
    // wikilink later in the bullet's prose (e.g. "feed the [[goal]] KPI") is never mistaken for a blocker.
    const paren = line.match(/\*\(([^)]*blocked[_ ]by[^)]*)\)/i);
    if (!paren || paren.index == null) continue;
    const before = line.slice(0, paren.index);
    const spec = specLinkSlugs(before)[0]; // the milestone spec named before the annotation
    if (!spec) continue;
    const inner = paren[1];
    const after = inner.slice(inner.search(/blocked[_ ]by/i)); // from the marker onward, within the parenthetical
    const blockers = [...new Set(specLinkSlugs(after))].filter((b) => b !== spec);
    if (!blockers.length) continue; // a foundation (`blocked_by []`) — no entry
    out.set(spec, blockers);
  }
  return out;
}

/** The newest ACTIVE (queued/building/needs_input/needs_approval/queued_resume) build job for a spec, or null. */
async function activeBuildJob(admin: Admin, workspaceId: string, slug: string): Promise<{ id: string; status: string } | null> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .in("status", [...ACTIVE_BUILD_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { id: (data as { id: string }).id, status: String((data as { status?: string }).status ?? "") };
}

/** A recent `reconciled_sequence` ledger row for this spec exists → already re-sequenced (fs-lag dedup). */
async function alreadyResequenced(admin: Admin, slug: string): Promise<boolean> {
  const sinceIso = new Date(Date.now() - PLATFORM_DIRECTOR_RECENT_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("director_activity")
    .select("id")
    .eq("director_function", PLATFORM)
    .eq("action_kind", "reconciled_sequence")
    .eq("spec_slug", slug)
    .gte("created_at", sinceIso)
    .limit(1);
  return !!(data && data.length);
}

/**
 * Detect milestone builds that fanned out concurrently before their prerequisites (read-only). For each goal
 * the director owns, transcribe its authored per-spec blocker annotations and flag every dependent spec that
 * is unshipped, has ≥1 UNMET (unshipped) declared blocker MISSING from its own `**Blocked-by:**` line (the
 * blocker-less-fan-out bug), and has an ACTIVE build (the jammed fan-out). Skips a spec already re-sequenced.
 * Bounded by PLATFORM_DIRECTOR_SEQUENCE_CAP; a NO-OP until Platform is live+autonomous. Best-effort.
 */
export async function findMilestoneSequenceViolations(admin: Admin): Promise<SequenceReconcileResult> {
  const empty: SequenceReconcileResult = { violations: [], scanned: 0 };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty; // dormant until activation flips the flag

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return empty;

  const goals = (await getGoals()).filter((g) => g.owner === PLATFORM && g.status !== "complete");
  if (!goals.length) return empty;
  const { specs } = await getRoadmap();
  const specBySlug = new Map(specs.map((s) => [s.slug, s]));

  const violations: MilestoneSequenceViolation[] = [];
  let scanned = 0;
  for (const goal of goals) {
    const got = await getGoal(goal.slug);
    if (!got) continue;
    const declared = parseGoalSpecBlockers(got.raw);
    for (const [slug, blockers] of declared) {
      const card = specBySlug.get(slug);
      if (!card || card.status === "shipped" || card.status === "deferred") continue;
      const unmet = blockers.filter((b) => specBySlug.get(b)?.status !== "shipped");
      if (!unmet.length) continue; // every prerequisite already shipped — building it now is in order
      const fileBlockers = new Set(card.blockedBy.map((b) => b.slug));
      const missingFromFile = unmet.filter((b) => !fileBlockers.has(b));
      if (!missingFromFile.length) continue; // the file already carries its blockers — the spec-blockers gate owns it
      scanned++;
      const job = await activeBuildJob(admin, workspaceId, slug); // an active build = the out-of-order fan-out
      if (!job) continue; // nothing fanned out — Phase 1 / the board will add the blocker the normal way
      if (await alreadyResequenced(admin, slug)) continue; // already handled (fs lag) — don't re-write/re-hold
      violations.push({ slug, goalSlug: goal.slug, goalTitle: goal.title, jobId: job.id, jobStatus: job.status, declaredBlockers: blockers, unmetBlockers: unmet, missingFromFile });
      if (violations.length >= PLATFORM_DIRECTOR_SEQUENCE_CAP) return { violations, scanned };
    }
  }
  return { violations, scanned };
}

/**
 * HOLD a premature milestone build — cancel the out-of-order fan-out by parking it at {@link SEQUENCE_HELD_STATUS}
 * with the reason. Re-asserts the job is still ACTIVE first (never clobbers a build that landed in the meantime).
 * Best-effort; never throws.
 */
export async function holdPrematureBuild(admin: Admin, jobId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await admin
    .from("agent_jobs")
    .update({ status: SEQUENCE_HELD_STATUS, error: reason.slice(0, 2000), log_tail: reason.slice(-2000) })
    .eq("id", jobId)
    .in("status", [...ACTIVE_BUILD_STATUSES]);
  return { ok: !error, error: error?.message };
}

/**
 * Return `md` with a `**Blocked-by:** [[a]], [[b]]` metadata line that LISTS every slug in `blockers`. If a
 * Blocked-by line already exists, merge in the missing slugs (order-preserving union); otherwise insert a fresh
 * line right after the H1 title. Returns `md` UNCHANGED when every blocker is already listed (idempotent — the
 * box lane skips the commit on a no-op). Pure; the box lane commits the result via the GitHub API.
 */
export function ensureBlockedByLine(md: string, blockers: string[]): string {
  if (!blockers.length) return md;
  const lines = md.split("\n");
  const idx = lines.findIndex((l) => /^\s*\*\*Blocked-by:\*\*/i.test(l));
  const existing = idx >= 0 ? specLinkSlugs(lines[idx]) : [];
  const union = [...existing];
  for (const b of blockers) if (!union.includes(b)) union.push(b);
  if (idx >= 0 && union.length === existing.length) return md; // nothing new to add
  const newLine = `**Blocked-by:** ${union.map((s) => `[[${s}]]`).join(", ")}`;
  if (idx >= 0) {
    lines[idx] = newLine;
    return lines.join("\n");
  }
  // No line yet — insert under the H1 (after the blank line that conventionally follows it, if present).
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  const at = h1 < 0 ? 0 : lines[h1 + 1]?.trim() === "" ? h1 + 2 : h1 + 1;
  lines.splice(at, 0, newLine, "");
  return lines.join("\n");
}

// ── Phase 4 — watch the platform + report to the board ────────────────────────────────────────────
// The director's TOP, human-legible layer: read Control Tower health (the EXISTING snapshot library —
// no new monitoring) and post a conversational update as 🛠️ Ada to the M3 #directors board — what it
// squashed (auto-approved fixes), what it's escorting (goals advanced), and what it escalated — on the
// daily standing beat. The other two Phase-4 surfaces reuse what already exists: "answers why?" is the
// directors-board-gamified Phase-2 dev-ask board wiring (routeBoardReply defaults to Platform), and the
// EOD-recap slice is the directors-board-gamified Phase-4 director-recap (Platform is a director, so its
// approved_approval / escorted_goal / escalated activity already rolls into the standup). Dormant until
// Platform is live+autonomous, exactly like the escort + the approval enqueuer.

/**
 * Activity action_kinds that count as "drove a spec" for the cross-dept rollup
 * (director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive Phase 1). Includes every
 * lane that ESCORTS/INITIATES/GROOMS a spec it drives — NOT `escalated` (the opposite of covering), NOT
 * the repair-dismissal kinds (no spec owner), NOT `approved_approval` (an approval is a leash decision,
 * not a drive of a spec on the board). Each row stamps `metadata.owner_function` at write-time; if that
 * field is non-platform, the row counts as a cross-dept drive.
 */
export const CROSS_DEPT_DRIVE_KINDS: ReadonlySet<string> = new Set([
  "escorted_fix",
  "escorted_init",
  "groomed_continue",
  "groomed_split",
  "groomed_fold_now",
  "groomed_authored_spec",
  "groomed_dismissed",
  "init_authored_spec",
  "init_dismissed",
]);

/** Platform's Control-Tower health, collapsed from the snapshot's platform department rollup. */
export interface PlatformHealth {
  /** worst-of color across platform-owned loops. */
  color: LoopColor;
  total: number;
  healthy: number;
  red: number;
  amber: number;
  openAlerts: number;
  /** labels of the red loops (for the body). */
  redLabels: string[];
}

/** What the director did today — the headline counts the board update reads back. */
export interface PlatformWatchActivity {
  /** auto-approved fixes today (approved_approval rows — "squashed 500s"). */
  squashed: number;
  /** goals advanced today (escorted_goal rows). */
  escorting: number;
  /** calls escalated to the CEO today (escalated rows). */
  escalated: number;
  /** stale parks the director dismissed today (dismissed_park rows) — director-dismiss-park-and-short-circuit-spec Phase 1. */
  dismissedParks: number;
  /** Rafa's no-fix calls reviewed today (dismissed + kept + escalated-from-review) — Phase 2 rollup. */
  reviewedRepairs: number;
  /** of those reviews, how many Ada cleared (dismissed_repair rows). */
  dismissedRepairs: number;
  /** of those reviews, how many she escalated back to the CEO (escalated rows, repair_dismissal_suspect). */
  escalatedRepairs: number;
  // needs-attention-triage-and-verdict-robustness Phase 3 — the parked-work KPI (so nothing rots silently).
  /** open needs_attention items the triage lane owns RIGHT NOW (non-build, non-repair) — a point-in-time count. */
  needsAttention: number;
  /** age in hours of the OLDEST open parked item (0 when none) — the "oldest Xh" half of the KPI. */
  needsAttentionOldestHours: number;
  /** recoverable parked items the director re-ran today (triaged_needs_attention action=rerun) — the day's triage. */
  triagedReran: number;
  // director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive Phase 1 — the cross-dept
  // KPI: drives of a spec OWNED by another department (a not-yet-live director), so the daily watch + the
  // Platform Department Scorecard can see the keystone covering for them. `crossDeptByOwner` is the per-owner
  // breakdown the watch line names; `crossDeptDrives` is the rollup sum.
  /** total drives today where the spec's owning function is non-platform (the keystone-cover count). */
  crossDeptDrives: number;
  /** per-owner breakdown of cross-dept drives today (e.g. `{cs:2, growth:1}`) for the watch line. */
  crossDeptByOwner: Record<string, number>;
  // director-zero-backlog-error-autonomy-visible-reversible Phase 1 — the error-autonomy F/D/R/E rollup,
  // so the CEO has after-the-fact visibility of what the error pipeline did overnight WITHOUT being
  // in the loop up front. Every "F fixed" is a `claude/<slug>` PR with the verification trail — one
  // `git revert` from undone (the reversibility half).
  /** F — repair-signed fix specs that shipped today (auto-merged `claude/<slug>` PRs, each revertable). */
  errorFixed: number;
  /** D — Rafa's no-fix items Ada dismissed as benign today (mirror of dismissedRepairs, named for the F/D/R/E rollup). */
  errorDismissedBenign: number;
  /** R — backlog signatures the zero-backlog reconciler enqueued a fresh repair for today (reconciled_error action=enqueued_repair). */
  errorReconciled: number;
  /** E — escalations to the CEO as an EXTERNAL break today (escalation_kind=external_blocker). The ONLY routine error→CEO touch. */
  errorEscalatedExternal: number;
}

/** The health half of the watch line — "all N platform loops green" / "K red (…)" / "X/N green, M degraded". */
function platformHealthLine(h: PlatformHealth): string {
  if (h.total === 0) return "no platform loops registered yet";
  if (h.color === "green") return `all ${h.total} platform loop${h.total === 1 ? "" : "s"} green`;
  if (h.color === "red") {
    const shown = h.redLabels.slice(0, 3).join(", ");
    const more = h.redLabels.length > 3 ? `, +${h.redLabels.length - 3} more` : "";
    const alerts = h.openAlerts ? `, ${h.openAlerts} open alert${h.openAlerts === 1 ? "" : "s"}` : "";
    return `${h.red} loop${h.red === 1 ? "" : "s"} red (${shown}${more})${alerts}`;
  }
  return `${h.healthy}/${h.total} platform loops green, ${h.amber} degraded`;
}

/** The activity half — "squashed N fixes · escorted M goals · escalated K to you", or a quiet day. */
function platformActivityLine(a: PlatformWatchActivity): string {
  const parts: string[] = [];
  if (a.squashed) parts.push(`squashed ${a.squashed} fix${a.squashed === 1 ? "" : "es"}`);
  if (a.escorting) parts.push(`escorted ${a.escorting} goal${a.escorting === 1 ? "" : "s"}`);
  if (a.escalated) parts.push(`escalated ${a.escalated} to you`);
  // director-dismiss-park-and-short-circuit-spec Phase 1 — surface the day's dismissed parks alongside the
  // existing rollup, so the CEO sees what was cleared without inspecting the activity ledger.
  if (a.dismissedParks) parts.push(`dismissed ${a.dismissedParks} stale park${a.dismissedParks === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "nothing needed a decision";
}

/**
 * The supervision-of-the-supervisor half (Phase 2) — "Reviewed N of Rafa's calls — dismissed K, escalated J
 * back to you." Only rendered on a day she actually reviewed at least one of Rafa's no-fix items.
 */
function platformRepairReviewLine(a: PlatformWatchActivity): string | null {
  if (!a.reviewedRepairs) return null;
  const calls = `${a.reviewedRepairs} of Rafa's call${a.reviewedRepairs === 1 ? "" : "s"}`;
  return `Reviewed ${calls} — dismissed ${a.dismissedRepairs}, escalated ${a.escalatedRepairs} back to you.`;
}

/**
 * The parked-work line (Phase 3) — "N items need attention, oldest Xh" + the day's triage ("re-ran K"), so a
 * rotting needs_attention item is VISIBLE on the board. Only rendered when something's parked or was re-run.
 */
function platformNeedsAttentionLine(a: PlatformWatchActivity): string | null {
  if (!a.needsAttention && !a.triagedReran) return null;
  const parts: string[] = [];
  if (a.needsAttention) parts.push(`${a.needsAttention} item${a.needsAttention === 1 ? "" : "s"} need${a.needsAttention === 1 ? "s" : ""} attention, oldest ${a.needsAttentionOldestHours}h`);
  if (a.triagedReran) parts.push(`re-ran ${a.triagedReran} today`);
  return parts.join("; ") || null;
}

/**
 * The keystone-cover line (director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive
 * Phase 1) — "Drove N specs for other departments (owner: K, owner: J)" on any day she escorted/initiated/groomed
 * a spec OWNED by another function (a not-yet-live director). Only rendered on a day she covered ≥1 cross-dept
 * spec; otherwise omitted so quiet days stay tidy. Per-owner breakdown sorted by count desc → name asc for stable
 * formatting. Caps the named-owner list at 4 with a "+K more" tail to keep the post readable.
 */
function platformCrossDeptLine(a: PlatformWatchActivity): string | null {
  if (!a.crossDeptDrives) return null;
  const owners = Object.entries(a.crossDeptByOwner).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = owners.slice(0, 4).map(([owner, n]) => `${owner}: ${n}`).join(", ");
  const more = owners.length > 4 ? `, +${owners.length - 4} more` : "";
  return `Drove ${a.crossDeptDrives} spec${a.crossDeptDrives === 1 ? "" : "s"} for other departments (${shown}${more}).`;
}

/**
 * The error-autonomy rollup (director-zero-backlog-error-autonomy-visible-reversible Phase 1) — the
 * after-the-fact F/D/R/E visibility line the CEO reads ONCE a day instead of being in the loop on every
 * fix. "Errors tonight: F fixed & shipped, D dismissed-benign, R reconciled from backlog, E escalated
 * to you as external." Each F is a `claude/<slug>` PR with the verification trail — one `git revert`
 * from undone (the reversibility half: visible AND reversible). Null on a day with zero error activity
 * so a quiet pipeline doesn't clutter the post.
 */
function platformErrorAutonomyLine(a: PlatformWatchActivity): string | null {
  const total = a.errorFixed + a.errorDismissedBenign + a.errorReconciled + a.errorEscalatedExternal;
  if (!total) return null;
  return `Errors tonight: ${a.errorFixed} fixed & shipped, ${a.errorDismissedBenign} dismissed-benign, ${a.errorReconciled} reconciled from backlog, ${a.errorEscalatedExternal} escalated to you as external.`;
}

/** Ada's conversational watch post (plain text, no markdown) — health + what she did today. */
export function composePlatformWatchBody(
  health: PlatformHealth,
  activity: PlatformWatchActivity,
  scorecardLine?: string | null,
  regressionLine?: string | null,
): string {
  const persona = getPersona(PLATFORM);
  const repairLine = platformRepairReviewLine(activity);
  const parkedLine = platformNeedsAttentionLine(activity);
  // director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive Phase 1 — the
  // keystone-cover line, so a day she escorted/initiated/groomed a CS/Growth/etc spec is visible
  // on the board (the "drove N for other departments" sentence). Null on a day with zero cross-dept work.
  const crossDeptLine = platformCrossDeptLine(activity);
  // director-zero-backlog-error-autonomy-visible-reversible Phase 1 — the dedicated F/D/R/E error-
  // autonomy rollup, so the CEO sees the overnight error pipeline at a glance without being in the
  // loop on each fix. Null on a quiet day (zero error activity).
  const errorAutonomyLine = platformErrorAutonomyLine(activity);
  const scorecard = scorecardLine ? ` ${scorecardLine}.` : "";
  // regression-backlog-reconciliation-scorecard Phase 1 — the D/F/R/E + coverage line, dedicated so the
  // regression flow is visible at a glance instead of buried in the Scorecard headline. Reads the snapshot
  // store via composeRegressionWatchLine ("read from the scorecard, never the raw tables").
  const regressions = regressionLine ? ` ${regressionLine}.` : "";
  return `${persona.emoji} Platform watch — ${platformHealthLine(health)}. Today: ${platformActivityLine(activity)}.${repairLine ? ` ${repairLine}` : ""}${parkedLine ? ` ${parkedLine}.` : ""}${crossDeptLine ? ` ${crossDeptLine}` : ""}${errorAutonomyLine ? ` ${errorAutonomyLine}` : ""}${scorecard}${regressions}`;
}

/**
 * Read the latest snapshot per (metric_key, cadence) from `platform_scorecard_snapshots` — the
 * board-watch + EOD-recap consumers ([[../specs/platform-scorecard-surface]] Phase 3). The
 * "read from the scorecard, never the raw tables" invariant ([[meta__scorecards]]) — both surfaces
 * read this trended store, so they never re-compute the KPIs the engine wrote. Best-effort: on read
 * error, returns empty groups so the watch line is simply omitted (no fabricated numbers).
 */
async function loadLatestScorecardSnapshots(
  admin: Admin,
  workspaceId: string,
): Promise<Record<ScorecardCadence, ScorecardSnapshotLite[]>> {
  const empty: Record<ScorecardCadence, ScorecardSnapshotLite[]> = { daily: [], weekly: [], monthly: [] };
  try {
    const { data } = await admin
      .from("platform_scorecard_snapshots")
      .select("metric_key, cadence, snapshot_date, value, delta_pct, unit, detail")
      .eq("workspace_id", workspaceId)
      .order("snapshot_date", { ascending: false })
      .limit(2000);
    const rows = (data ?? []) as Array<{
      metric_key: string;
      cadence: string;
      snapshot_date: string;
      value: number | string;
      delta_pct: number | string | null;
      unit: string;
      detail: Record<string, unknown> | null;
    }>;
    const seen = new Set<string>();
    for (const r of rows) {
      const cadence = r.cadence as ScorecardCadence;
      if (cadence !== "daily" && cadence !== "weekly" && cadence !== "monthly") continue;
      const key = `${cadence}::${r.metric_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const value = typeof r.value === "number" ? r.value : Number(r.value);
      const deltaRaw = r.delta_pct;
      const deltaPct = deltaRaw == null ? null : typeof deltaRaw === "number" ? deltaRaw : Number(deltaRaw);
      empty[cadence].push({
        metric_key: r.metric_key,
        value: Number.isFinite(value) ? value : 0,
        delta_pct: deltaPct != null && Number.isFinite(deltaPct) ? deltaPct : null,
        unit: r.unit,
        detail: r.detail ?? undefined,
      });
    }
  } catch {
    /* best-effort — fall through to empty groups */
  }
  return empty;
}

/**
 * Post the daily Platform watch update to the M3 #directors board (Phase 4). Reads the Control Tower
 * snapshot for the platform department's health + today's director_activity for what it squashed /
 * escorted / escalated, then posts ONE conversational `update` as 🛠️ Ada. Idempotent per (workspace,
 * UTC day) via `metadata.watch_date` (a box re-claim never double-posts), and a NO-OP until Platform is
 * live+autonomous. Skips a fully-quiet, all-green day (no empty-board spam). Best-effort; never throws on
 * a snapshot read — the caller logs the result.
 */
export async function postPlatformWatchUpdate(admin: Admin, opts?: { date?: string }): Promise<{ posted: boolean; reason?: string }> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return { posted: false, reason: "dormant" }; // dormant until Phase 4 flips the flag

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return { posted: false, reason: "no_workspace" };

  const date = opts?.date ?? new Date().toISOString().slice(0, 10);

  // Idempotent per UTC day — one watch post per (workspace, day), so a re-claimed standing job never double-posts.
  const { data: existingPost } = await admin
    .from("director_messages")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("author_function", PLATFORM)
    .eq("kind", "update")
    .eq("metadata->>source", "platform-watch")
    .eq("metadata->>watch_date", date)
    .limit(1)
    .maybeSingle();
  if (existingPost) return { posted: false, reason: "already_posted" };

  // Health — the EXISTING Control Tower snapshot, collapsed to the platform department (no new monitoring).
  const snapshot = await buildControlTowerSnapshot(admin);
  const dept = snapshot.departments.find((d) => d.owner === PLATFORM);
  const redLabels = snapshot.loops.filter((l) => l.owner === PLATFORM && l.color === "red").map((l) => l.label);
  const health: PlatformHealth = dept
    ? { color: dept.color, total: dept.total, healthy: dept.healthy, red: dept.counts.red, amber: dept.counts.amber, openAlerts: dept.openAlerts, redLabels }
    : { color: "green", total: 0, healthy: 0, red: 0, amber: 0, openAlerts: 0, redLabels: [] };

  // Today's director activity — what it squashed / escorted / escalated (same UTC-day window as the recap).
  const dayStart = new Date(date + "T00:00:00.000Z").toISOString();
  const dayEnd = new Date(new Date(date + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000).toISOString();
  const { data: activityRows } = await admin
    .from("director_activity")
    .select("action_kind, metadata")
    .eq("workspace_id", workspaceId)
    .eq("director_function", PLATFORM)
    .gte("created_at", dayStart)
    .lt("created_at", dayEnd);
  const activity: PlatformWatchActivity = { squashed: 0, escorting: 0, escalated: 0, dismissedParks: 0, reviewedRepairs: 0, dismissedRepairs: 0, escalatedRepairs: 0, needsAttention: 0, needsAttentionOldestHours: 0, triagedReran: 0, crossDeptDrives: 0, crossDeptByOwner: {}, errorFixed: 0, errorDismissedBenign: 0, errorReconciled: 0, errorEscalatedExternal: 0 };
  for (const r of (activityRows ?? []) as { action_kind: string; metadata: Record<string, unknown> | null }[]) {
    const escalationKind = typeof r.metadata?.["escalation_kind"] === "string" ? (r.metadata["escalation_kind"] as string) : null;
    const reconcileAction = typeof r.metadata?.["action"] === "string" ? (r.metadata["action"] as string) : null;
    const repairEscalation = r.action_kind === "escalated" && escalationKind === "repair_dismissal_suspect";
    if (r.action_kind === "approved_approval") activity.squashed++;
    else if (r.action_kind === "escorted_goal") activity.escorting++;
    else if (r.action_kind === "escalated") activity.escalated++;
    // director-dismiss-park-and-short-circuit-spec Phase 1 — the day's stale-park dismissals.
    else if (r.action_kind === "dismissed_park") activity.dismissedParks++;
    // Phase 2 rollup — each review of one of Rafa's no-fix calls (a dismiss, a keep, or an escalate-back).
    if (r.action_kind === "dismissed_repair") {
      activity.dismissedRepairs++;
      activity.reviewedRepairs++;
      // director-zero-backlog-error-autonomy-visible-reversible Phase 1 — the F/D/R/E rollup's D
      // (dismissed-benign) — Ada's supervised dismissal of one of Rafa's no-fix calls. Mirror of
      // dismissedRepairs, named for the error-autonomy panel.
      activity.errorDismissedBenign++;
    } else if (r.action_kind === "kept_repair") {
      activity.reviewedRepairs++;
    } else if (repairEscalation) {
      activity.escalatedRepairs++;
      activity.reviewedRepairs++;
    }
    // director-zero-backlog-error-autonomy-visible-reversible Phase 1 — the F/D/R/E rollup's R + E.
    // R (reconciled from backlog): a backlog signature the zero-backlog reconciler found uncovered
    // and enqueued a fresh repair for (metadata.action='enqueued_repair' from reconcileErrorBacklog);
    // a stuck-build escalation (`escalated_stuck`) is NOT an R — it'll be counted under E if external,
    // or stays in the generic `escalated` rollup otherwise.
    if (r.action_kind === "reconciled_error" && reconcileAction === "enqueued_repair") activity.errorReconciled++;
    // E (escalated to you as external): the ONLY routine error→CEO touch — director-supervised-repair-dismissal
    // Phase 2's external-blocker escalation, where the verified diagnosis is a third-party dependency break
    // beyond our retry/breaker. Distinct from the generic `escalated` count so the CEO can see "what HIT my
    // inbox as needing a business decision" at a glance.
    if (r.action_kind === "escalated" && escalationKind === "external_blocker") activity.errorEscalatedExternal++;
    // Phase 3 — the day's needs_attention triage: how many recoverable parked items the director re-ran.
    if (r.action_kind === "triaged_needs_attention" && r.metadata?.["action"] === "rerun") activity.triagedReran++;
    // director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive Phase 1 — count any
    // "drove a spec" action where the OWNING function is non-platform: the keystone covering for a
    // not-yet-live director. Filters on action_kind (init/fix/groom lanes only) so an `escalated` row that
    // happens to carry a stamped owner doesn't double-count as a "drive" — escalation is the OPPOSITE of
    // covering. Each row counts once; the per-owner breakdown is what the watch line names.
    if (CROSS_DEPT_DRIVE_KINDS.has(String(r.action_kind))) {
      const ownerFn = typeof r.metadata?.["owner_function"] === "string" ? (r.metadata["owner_function"] as string) : null;
      if (ownerFn && ownerFn !== PLATFORM) {
        activity.crossDeptDrives++;
        activity.crossDeptByOwner[ownerFn] = (activity.crossDeptByOwner[ownerFn] ?? 0) + 1;
      }
    }
  }

  // director-zero-backlog-error-autonomy-visible-reversible Phase 1 — F (fixed & shipped) in the F/D/R/E
  // rollup. Source: spec_status_history rows transitioned to status='shipped' today by a merge actor
  // (`actor LIKE 'merge:%'` — the build-merge hook is the only authoritative shipped writer; an owner /
  // drift / Ada flip is NOT an auto-fix shipping), filtered to repair-signed specs (`SpecCard.repairSignature`
  // — the Repair-signature marker Rafa stamps on every fix spec). Each F is a `claude/<slug>` PR with the
  // verification trail (tsc + CI + spec-test), one `git revert` from undone — that's the reversibility half:
  // the CEO gets after-the-fact visibility AND an instant undo without being in the loop up front.
  // Best-effort: a missing audit table / read error swallows to 0 (no fabricated count).
  try {
    const { data: shipped } = await admin
      .from("spec_status_history")
      .select("spec_slug, actor")
      .eq("workspace_id", workspaceId)
      .eq("field", "status")
      .eq("to_value", '"shipped"')
      .gte("at", dayStart)
      .lt("at", dayEnd)
      .limit(500);
    const shippedSlugs = new Set<string>();
    for (const row of (shipped ?? []) as Array<{ spec_slug?: string | null; actor?: string | null }>) {
      const slug = String(row.spec_slug ?? "");
      const actor = String(row.actor ?? "");
      if (!slug || !actor.startsWith("merge:")) continue;
      shippedSlugs.add(slug);
    }
    if (shippedSlugs.size) {
      const { specs } = await getRoadmap();
      const repairSignedShippedSlugs = specs.filter((s) => s.repairSignature && shippedSlugs.has(s.slug));
      activity.errorFixed = repairSignedShippedSlugs.length;
    }
  } catch {
    /* best-effort — leave errorFixed at 0 on a read error */
  }

  // needs-attention KPI (Phase 3) — the open parked-work snapshot (count + oldest age), scoped to the items
  // the triage lane owns (non-build, non-repair), so a rotting item is visible on the board even on a green day.
  const { data: parkedRows } = await admin
    .from("agent_jobs")
    .select("kind, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "needs_attention")
    .order("created_at", { ascending: true })
    .limit(200);
  const parked = ((parkedRows ?? []) as { kind: string; created_at: string }[]).filter((j) => !TRIAGE_SKIP_KINDS.has(String(j.kind)));
  activity.needsAttention = parked.length;
  activity.needsAttentionOldestHours = parked.length ? Math.max(0, Math.floor((Date.now() - Date.parse(String(parked[0].created_at))) / 3_600_000)) : 0;

  // Don't spam a fully-quiet, all-green day — post only when there's health to flag, work to report, or a
  // parked item that needs eyes (so a rotting needs_attention surfaces even when every loop is green).
  // director-zero-backlog-error-autonomy-visible-reversible Phase 1 — also post on a day the error pipeline
  // did ANY F/D/R/E work, so the autonomous fixes/dismisses/reconciles are visible even when every loop
  // landed green by post time (the whole point of the rollup is the CEO seeing what happened overnight).
  const errorAutonomyActivity = activity.errorFixed + activity.errorDismissedBenign + activity.errorReconciled + activity.errorEscalatedExternal;
  const hasActivity = activity.squashed > 0 || activity.escorting > 0 || activity.escalated > 0 || activity.reviewedRepairs > 0 || activity.needsAttention > 0 || activity.triagedReran > 0 || errorAutonomyActivity > 0;
  if (!hasActivity && health.color === "green") return { posted: false, reason: "quiet" };

  // Phase 3 (platform-scorecard-surface) — the one-line scorecard summary, reading the trended store
  // ([[../tables/platform_scorecard_snapshots]]). No KPIs persisted yet → the line is omitted (no
  // fabricated numbers), same invariant the surface page enforces.
  const snapshots = await loadLatestScorecardSnapshots(admin, workspaceId);
  const scorecardLine = composeScorecardWatchLine(snapshots);
  // regression-backlog-reconciliation-scorecard Phase 1 — the dedicated regression D/F/R/E + coverage line
  // (null when no daily activity AND no coverage value yet — keeps a quiet day tidy).
  const regressionLine = composeRegressionWatchLine(snapshots);

  await postDirectorMessage({
    workspaceId,
    author: "director",
    authorFunction: PLATFORM,
    body: composePlatformWatchBody(health, activity, scorecardLine, regressionLine),
    kind: "update",
    metadata: {
      source: "platform-watch",
      watch_date: date,
      health,
      activity,
      scorecard_line: scorecardLine ?? null,
      regression_line: regressionLine ?? null,
    },
  });
  return { posted: true };
}

// ── Phase 5 — board grooming (the director MOVES the project board) ───────────────────────────────
// The director doesn't just build queued specs — it actively GROOMS the board so nothing rots half-built
// (board-grooming spec). On its standing cadence it assesses every PARTIALLY-shipped spec (≥1 phase ✅,
// remaining ⏳, no active build) and decides what to do with the leftover phases:
//   - CONTINUE — the next ⏳ phase is NEEDED NOW (the spec's current promise / a dependent / a goal needs
//     it) → queue its build to completion (the chain + auto-ship + fold carry it, like the escort).
//   - SPLIT — the leftover phase(s) are future enhancement/polish the spec doesn't need to be useful today
//     → author each as its OWN planned card (`{slug}-{phase}.md`, ⏳, a `**Deferred:**` note) and CLOSE OUT
//     the parent (remove the split phases so its remaining phases are all-✅ → the parent folds/ships).
//     Future work is PRESERVED as a planned card, never dropped.
//   - ESCALATE — genuinely unsure / high-stakes (could be load-bearing) → escalate to the CEO, move nothing
//     (north-star: hit a rail → escalate, never guess).
//
// Supervisable: splitting a card + queueing a next-phase build is low-risk/reversible (within the leash);
// every groom decision writes a director_activity row with the reasoning. The director never DELETES a
// phase outright — future work is always preserved as a planned card. Dormant until live+autonomous, like
// the escort + the approval enqueuer. The classification JUDGMENT is the director's Max `claude -p`
// investigation (the box lane), exactly like the Phase-1 approval verdict + the regression-agent author;
// this module is the mechanical half — find the candidates, build the prompt, dedup against re-grooming.

/** Absolute per-pass safety ceiling on grooming `claude -p` investigations. The SATURATION TARGET
 *  ({@link idleBuildCapacity}, director-initiation-throughput Phase 1) normally binds first; this is the
 *  hard cap = the pool ceiling, so a pass never runs more investigations than there are lanes to fill. */
export const PLATFORM_DIRECTOR_GROOM_CAP = BUILD_POOL_CAPACITY;

/** A partially-shipped spec the director may groom: ≥1 ✅ phase, ≥1 ⏳ phase, none 🚧, no active build. */
export interface GroomCandidate {
  slug: string;
  title: string;
  owner?: string;
  parent?: string;
  shippedPhases: string[]; // titles of the ✅ phases WITH merge-hook provenance (real shipped, ready to fold)
  /** director-trust-phase-pr-provenance Phase 1: ✅ phases that LACK a `pr` tag — DRIFT SUSPECT. Surfaced
   *  distinctly in the groom brief so Ada doesn't classify a fully-shipped-but-tagless spec as ready-to-fold;
   *  the merge hook is the only authoritative `pr` writer, so a tagless ✅ phase means we can't prove the
   *  merge landed. Titles only (matches the brief shape). */
  driftSuspectPhases: string[];
  remainingPhases: string[]; // titles of the leftover ⏳ phases (what gets classified)
  raw: string; // the parent spec's full markdown — the investigation reads it + (on a split) rewrites it
  /** prior failed build attempts (no in-flight) — the loop-guard count the continue path reads. */
  failedBuilds: number;
  lastError: string | null;
}

/** The stable dedup key for a terminal groom decision on a spec (split / unsure-escalate). */
export function groomKey(slug: string): string {
  return `groom:${slug}`;
}

/**
 * Has this spec ALREADY had a terminal groom decision (split / fold_now / author_followup_spec /
 * dismiss_candidate / escalated as unsure)? A terminal mutation commits to `main` (or the DB mirror),
 * which the box's bundled `fs` copy won't reflect until its next self-update — so without this ledger
 * dedup the same candidate would re-fire every pass. (A `continue` is NOT deduped here: its queued
 * build flips the spec in-flight, which the candidate filter already excludes, and a later FAILED
 * build should be re-groomed under the loop-guard.) Best-effort.
 */
export async function alreadyGroomed(admin: Admin, slug: string): Promise<boolean> {
  const { data } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("director_function", PLATFORM)
    .in("action_kind", ["groomed_split", "groomed_fold_now", "groomed_authored_spec", "groomed_dismissed", "escalated"])
    .order("created_at", { ascending: false })
    .limit(1000);
  const key = groomKey(slug);
  return (data ?? []).some((r) => (r.metadata as Record<string, unknown> | null)?.["groom_key"] === key);
}

/**
 * Find the partially-shipped specs the Platform director may groom this pass: derived status not yet
 * shipped, ≥1 phase ✅ AND ≥1 phase ⏳, none in-progress (🚧), no active build job, owner not opted out
 * (`**Auto-build:** off`, mirroring the escort), and not already groomed (split/escalated). A NO-OP until
 * Platform is live+autonomous (dormant until activation, like the escort). Capped at GROOM_CAP per pass.
 */
export async function findGroomCandidates(admin: Admin): Promise<GroomCandidate[]> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return []; // dormant until activation flips the flag
  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return [];

  // Saturation target (Phase 1): groom only enough to fill the idle lanes — a grooming `continue` queues a
  // build, so a full pool means nothing to top up this pass (the 5-min beat / merge top-up retries). Bounded
  // also by the absolute GROOM_CAP ceiling. Lanes full → no candidates.
  const target = Math.min(PLATFORM_DIRECTOR_GROOM_CAP, await idleBuildCapacity(admin, workspaceId));
  if (target <= 0) return [];

  const { specs } = await getRoadmap();
  // director-trust-phase-pr-provenance Phase 1 + spec-goal-branch-pm-flow M2: a candidate is partially-BUILT
  // iff ≥1 phase is BUILT (on the spec branch via build_sha, OR shipped to main) AND ≥1 phase is planned.
  //
  // M2 — the gate MUST recognize branch-build, not just main-merge provenance. Under M1's branch-accumulation
  // model a multi-phase spec's phases build one-by-one onto ONE persistent `claude/build-{slug}` PR and are
  // NOT merged to main per phase, so NO phase carries a `pr` tag until M5 promotes the whole spec. The old
  // `provenanceShippedCount(s) >= 1` (pr-tag-gated) therefore reads 0 for the ENTIRE life of a branch-flow
  // spec → the next-phase advance would never fire. `branchBuiltCount` reads the build_sha (or shipped)
  // signal instead, so phase N being built on the branch makes the spec a candidate to advance phase N+1.
  //
  // The static `counts.in_progress === 0` gate is RETIRED here: under branch-flow a built phase reads
  // `in_progress` (built, not shipped), so that gate would wrongly exclude every branch-built spec. The
  // "don't groom a spec mid-build" guard moves to the per-candidate `state.activeBuild` check below (line
  // ~3068), which is precise — it distinguishes an ACTIVE build job (queued/building) from a landed
  // (completed/merged) one, where a landed phase SHOULD advance the next ⏳ phase.
  const partial = specs.filter(
    (s) =>
      !isCardFullyShippedWithProvenance(s) &&
      s.status !== "deferred" && // parked — grooming skips a deferred spec (director-drives-all-specs-and-deferred-status Phase 1)
      branchBuiltCount(s) >= 1 && // ≥1 phase BUILT on the branch (build_sha) or shipped — M2 branch-flow signal
      s.counts.planned >= 1 && // at least one ⏳ phase remains
      s.autoBuild !== false, // owner opted out of auto-build → leave it under manual control (mirrors the escort)
  );

  const out: GroomCandidate[] = [];
  for (const s of partial) {
    if (out.length >= target) break;
    const state = await specBuildState(admin, workspaceId, s.slug);
    if (state.activeBuild) continue; // an ACTIVE build is carrying it — a merged/completed (landed) build does NOT block: a landed phase should advance the next ⏳ phase
    if (await alreadyGroomed(admin, s.slug)) continue; // already split/escalated (handles the box's stale fs)
    const got = await getSpec(s.slug);
    if (!got) continue;
    out.push({
      slug: s.slug,
      title: s.title,
      owner: s.owner,
      parent: s.parent,
      // director-trust-phase-pr-provenance Phase 1: split ✅ phases into REAL (with `pr`) vs DRIFT SUSPECT
      // (no `pr`) so the brief surfaces them distinctly. A tagless ✅ phase is not "ready to fold."
      shippedPhases: s.phases.filter(phaseHasProvenance).map((p) => p.title),
      driftSuspectPhases: driftSuspectPhases(s).map((p) => p.title),
      remainingPhases: s.phases.filter((p) => p.status === "planned").map((p) => p.title),
      raw: got.raw,
      failedBuilds: state.failedCount,
      lastError: state.lastError,
    });
  }
  return out;
}

/** What the phase-progression backstop did this pass (per-spec advance outcomes). */
export interface PhaseProgressionResult {
  /** spec slugs whose NEXT planned phase was queued onto `claude/build-{slug}` this pass. */
  advanced: string[];
  /** spec slugs that were candidates (≥1 phase built, ≥1 planned, no active build) but `queueNextChainedPhase`
   *  no-op'd — already in-flight / dedup hit / nothing planned (the common idempotent case). */
  skipped: string[];
  /** candidate specs scanned (partially-built + driver-scoped). */
  scanned: number;
}

/**
 * PHASE-PROGRESSION BACKSTOP — Ada's mechanical heartbeat that shepherds a multi-phase spec P1→P2→…→Pn to
 * completion. This is the reliable-heartbeat half of Ada's spec-shepherding role (the brain doc): the
 * REACTIVE chain (`queueNextChainedPhase`, fired from runBuildJob the instant phase N's branch-build
 * completes) is the PRIMARY trigger; this standing-pass backstop guarantees the spec never stalls
 * mid-accumulation if that reactive chain MISSES (a worker crash between build-complete and the chain
 * insert, a director-initiated single build with the chain off, a transient DB hiccup).
 *
 * WHY a standing-pass backstop is REQUIRED, not just nice-to-have — the SAME event-only fragility Gate-A,
 * the pre-merge legs, and the spec-review backstop each had: the only other thing that advances P_{N+1}
 * after P_N builds is (a) the reactive chain (event-only — misses on a crash/transient) and (b) the GROOM
 * lane (`findGroomCandidates` → CONTINUE) — but grooming is a Max `claude -p` JUDGMENT lane: it's
 * capacity-gated (`idleBuildCapacity`), deduped by `alreadyGroomed` (a prior split/escalate verdict
 * suppresses it from re-firing), and can legitimately decline to continue. So a spec whose reactive chain
 * missed AND whose groom verdict wasn't "continue" would sit half-accumulated forever. This is the cheap,
 * un-gated, always-runs heartbeat that closes that gap — no Max investigation, pure mechanical advance.
 *
 * The advance itself REUSES `queueNextChainedPhase` (the existing, workspace-correct chain helper) — it does
 * NOT reinvent the queueing. That helper:
 *   - reads the spec's DERIVED phases via `getSpec(slug, workspaceId)` and picks the FIRST `planned` phase
 *     → ACCUMULATION ORDER (the lowest un-built planned phase) is structurally guaranteed;
 *   - DEDUPES on the scoped-instruction match (never re-queues a phase already queued) AND on any in-flight
 *     build for the spec (never stacks on a concurrent build) → never double-queues a phase in flight;
 *   - inserts the next phase as a `chain_phases:true` queued build on the spec's `claude/build-{slug}` branch
 *     (create-or-extend checks out the existing branch tip), and no-ops when no planned phase remains.
 *
 * RESPECTS, in addition to the helper's own guards:
 *   - the spec-review gate — `specReviewDone(card)` is the SAME `vale_review_passed_at`-backed durable signal
 *     every other Ada build-enqueue lane gates on; an `in_review` / un-Vale-passed spec is NEVER advanced;
 *   - one-phase-per-session scoping — we advance exactly ONE next phase per spec (`queueNextChainedPhase`
 *     queues a single `phaseScopedInstructions` phase, which the worker builds and then chains the next);
 *   - the build-driver keystone — only specs Ada drives (`platformDrivesSpec`), the same scope as every
 *     other lane; that is EVERY spec while Platform is live+autonomous (owner-agnostic — Ada is the sole builder);
 *   - blocked / opted-out / deferred / fully-shipped specs are skipped (mirrors the escort + groom filters).
 *
 * Idempotent + best-effort: a no-op when there's nothing to advance, swallows per-spec errors, never throws.
 * Dormant until Platform is live+autonomous (like every other lane). Runs every standing pass — cheap (one
 * roadmap read + a per-candidate build-state probe), so re-running it each pass is safe.
 */
export async function backstopPhaseProgression(admin: Admin): Promise<PhaseProgressionResult> {
  const empty: PhaseProgressionResult = { advanced: [], skipped: [], scanned: 0 };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty; // dormant until activation flips the flag
  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return empty;
  const chart = await buildOrgChartGraph();

  const { queueNextChainedPhase } = await import("@/lib/agent-jobs");
  const result: PhaseProgressionResult = { ...empty };

  let specs: SpecCard[];
  try {
    ({ specs } = await getRoadmap());
  } catch {
    return result; // a PM-read blip — the reactive chain + groom lane backstop us; never throw
  }

  // Candidate = a multi-phase spec the director drives that is PARTIALLY accumulated: ≥1 phase BUILT on the
  // branch (build_sha or shipped — branchBuiltCount, the M2 branch-flow signal) AND ≥1 phase still planned
  // (a next phase to advance). Same partial-built predicate the groom candidate filter uses, minus the
  // capacity/Max gates — this is the mechanical heartbeat, so it has none.
  const partial = specs.filter(
    (s) =>
      !isCardFullyShippedWithProvenance(s) && // already done — nothing to advance
      s.status !== "deferred" && // parked — never advance a deferred spec (mirrors groom/init)
      s.status !== "shipped" && // a tagless-but-shipped rollup: the drift lanes handle it, not us
      specReviewDone(s) && // spec-review gate — NEVER advance an un-Vale-passed / in_review spec
      s.autoBuild !== false && // owner opted out of auto-build → leave it under manual control
      !s.blockedBy.some((b) => !b.cleared) && // still blocked → its auto-queue fires when the last blocker ships
      platformDrivesSpec(s.owner, chart, autonomy) && // owner-agnostic, keystone-routed: this director drives it
      branchBuiltCount(s) >= 1 && // ≥1 phase BUILT on the branch (build_sha) or shipped — the spec is STARTED
      s.counts.planned >= 1, // ≥1 planned phase remains → there is a next phase to advance
  );
  result.scanned = partial.length;

  for (const s of partial) {
    try {
      // DEDUPE (precise): never advance a spec with an ACTIVE build job — a queued/building/needs_* build is
      // already carrying the next phase. A LANDED (completed/merged) build does NOT block: that's exactly the
      // case the reactive chain may have missed (its post-complete `queueNextChainedPhase` never ran), so we
      // advance. `queueNextChainedPhase` ALSO re-checks in-flight + scoped-instruction dedup internally, so
      // this is the first of two dedup gates (cheap pre-filter + the helper's authoritative check).
      const bs = await specBuildState(admin, workspaceId, s.slug);
      if (bs.activeBuild) {
        result.skipped.push(s.slug);
        continue;
      }
      // REUSE the existing chain helper — it picks the FIRST planned phase (accumulation order), dedupes, and
      // queues exactly one `chain_phases` phase onto `claude/build-{slug}`. Returns the queued phase title, or
      // null (already in-flight / nothing planned → the idempotent no-op).
      const queued = await queueNextChainedPhase(workspaceId, s.slug);
      if (queued) {
        result.advanced.push(s.slug);
        // Log the autonomous advance so the board + recap reflect that Ada shepherded this phase.
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: PLATFORM,
          actionKind: "escorted",
          specSlug: s.slug,
          reason: `phase-progression backstop: reactive chain missed — advanced next phase "${queued}" to keep ${s.slug} accumulating to completion.`,
          metadata: { lane: "phase_progression_backstop", phase: queued, autonomous: true },
        }).catch(() => {});
      } else {
        result.skipped.push(s.slug);
      }
    } catch {
      // best-effort per spec — one spec's failure never blocks the rest (the reactive chain + groom backstop)
      result.skipped.push(s.slug);
    }
  }
  return result;
}

/** What the stuck-accumulation backstop did this pass (per-spec unwedge outcomes). */
export interface StuckAccumulationResult {
  /** spec slugs whose un-stamped, branch-committed phases were stamped this pass (accumulation now completes). */
  unwedged: { slug: string; branch: string; positions: number[]; headSha: string }[];
  /** candidate specs scanned (multi-phase, partially built, driver-scoped, ≥1 planned phase without build_sha). */
  scanned: number;
  /** the read failed (no GH token, list-open-PRs API blip) — we skipped this pass. */
  aborted: boolean;
}

/**
 * accumulation-stamp-gap-and-rollback-guard P2 — DEFENSE-IN-DEPTH BACKSTOP for the stamp-gap wedge P1 fixes at
 * the FINALIZE-time seam. Root cause recap: a multi-phase spec accumulates onto ONE `claude/build-{slug}`
 * branch; the PR only opens when every phase carries a `build_sha` (`isSpecAccumulationComplete`). If a phase
 * committed during a `needs_input`/`needs_approval` PAUSE and the finalize path never derived that position
 * to stamp, the branch holds ALL the code but the DB says the accumulation is incomplete FOREVER — the PR
 * never opens, the auto-merge gate can't fire, and the director re-grooms into the same trap ('no new edits …
 * PR deferred — positions N not built'). This exact wedge held cleo-lever-priors, ada-standing-pass, and
 * grading-cascade on 2026-07-01 until a human hand-stamped each.
 *
 * P1's finalize-time writer catches the wedge the moment the CURRENT run stamps its own phase (it also stamps
 * every OTHER `Phase: N` trailer on the branch, from `git log origin/main..HEAD`). This standing-pass
 * backstop covers the case that P1 CAN'T: a run that ALREADY TERMINATED (completed/needs_input/needs_approval)
 * with the wedge in place — for those, the finalize scan doesn't fire again until someone re-queues a build,
 * which the director's groom is refusing to do because the derived status shows nothing new to add.
 *
 * WEDGE SIGNATURE (all four are required — deliberately narrow):
 *   1. multi-phase spec Ada drives (>1 phase, `platformDrivesSpec`, Vale-passed, `autoBuild!=false`);
 *   2. NOT already fully shipped / deferred / folded;
 *   3. at least one phase built-on-branch (branchBuiltCount ≥ 1 — the spec is genuinely started);
 *   4. at least one non-terminal phase carries NO `build_sha` (an "unstamped" position — the wedge slot);
 *   5. `claude/build-{slug}` is NOT the head of any open claude/build-* PR (the M4 auto-merge / auto-open path
 *      is NOT waiting on a green check — the PR simply never opened);
 *   6. the branch has a `Phase: N` trailer for each unstamped position (the code is genuinely on the branch);
 *   7. `isSpecAccumulationComplete` still reports FALSE in the DB (the wedge is live right now).
 *
 * The intersection stamps `stampPhaseBuilt(pos, {build_sha: branchHeadSha})` for each unstamped position whose
 * trailer proves the code is on the branch — the SAME leaf write P1 uses at finalize time. The NEXT tick of
 * the finalize/promote path (Gate A backstop, `queueNextChainedPhase` retry, or any subsequent runBuildJob)
 * reads accumulation as complete and opens the PR autonomously. Bounded to acts ONLY on the precise wedge
 * shape — a legitimately in-progress build has an active job, a happy multi-phase spec's PR is open, a spec
 * with an in-flight resolve is on someone else's plate — so this NEVER touches a healthy spec.
 *
 * IDEMPOTENT + FAIL-CLOSED: `stampPhaseBuilt` is a no-op on a terminal phase and harmless when the same SHA is
 * re-stamped; the fetch helpers return `null` on ANY GitHub failure so a blind guess never stamps a phase.
 * SURFACES the heal (never silent — north star) via a `director_activity` row per spec unwedged so the CEO
 * sees each self-heal ("unwedged stuck accumulation: {slug}"). DORMANT until Platform is live+autonomous.
 */
export async function backstopStuckAccumulation(admin: Admin): Promise<StuckAccumulationResult> {
  const empty: StuckAccumulationResult = { unwedged: [], scanned: 0, aborted: false };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty; // dormant until activation
  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return empty;
  const chart = await buildOrgChartGraph();

  let specs: SpecCard[];
  try {
    ({ specs } = await getRoadmap());
  } catch {
    return empty; // a PM-read blip — the other backstops carry us; never throw
  }

  // Candidate wedge signature (steps 1-4 above) — every spec Ada drives that could be wedged. The PR-check +
  // trailer-check (steps 5-6) + accumulation re-read (step 7) run per-candidate below (GitHub call cost).
  const candidates = specs.filter(
    (s) =>
      !isCardFullyShippedWithProvenance(s) &&
      s.status !== "deferred" &&
      s.status !== "shipped" &&
      specReviewDone(s) &&
      s.autoBuild !== false &&
      platformDrivesSpec(s.owner, chart, autonomy) &&
      s.phases.length > 1 && // multi-phase — a one-shot spec cannot wedge on accumulation (trivially complete)
      branchBuiltCount(s) >= 1 && // ≥1 phase already built on the branch (the spec is genuinely started)
      s.phases.some(
        (p) => p.status !== "shipped" && p.status !== "rejected" && !p.build_sha,
      ), // ≥1 non-terminal phase without a build_sha — the unstamped position(s) we might stamp
  );
  const result: StuckAccumulationResult = { unwedged: [], scanned: candidates.length, aborted: false };
  if (!candidates.length) return result;

  // Step 5 (read once): the set of branch refs already surfaced as an OPEN claude/build-* PR. A candidate whose
  // branch is in this set is NOT wedged (a PR exists — its auto-merge gate is being evaluated elsewhere).
  // Fail CLOSED — a GitHub list failure never gets treated as "no open PRs" (that would over-stamp), so we
  // abort this pass and let the next one retry with a healthy GH connection.
  const { listOpenClaudeBuildBranches, readBranchPhaseTrailers } = await import("@/lib/github-pr-resolve");
  let openBuildBranches: Set<string> | null;
  try {
    openBuildBranches = await listOpenClaudeBuildBranches();
  } catch {
    openBuildBranches = null;
  }
  if (!openBuildBranches) {
    result.aborted = true;
    return result;
  }

  const { stampPhaseBuilt, isSpecAccumulationComplete, getSpec } = await import("@/lib/specs-table");

  for (const s of candidates) {
    try {
      const branch = `claude/build-${s.slug}`;
      // Step 5: an open PR on this branch means the promote path OWNS it — don't cross-stamp.
      if (openBuildBranches.has(branch)) continue;

      // Step 6: read the branch's head SHA + Phase: trailer positions from GitHub. `null` = the branch doesn't
      // exist / GitHub blipped / no token → fail CLOSED (never stamp on absence of a positive read).
      let trailers: { headSha: string; positions: Set<number> } | null;
      try {
        trailers = await readBranchPhaseTrailers(branch);
      } catch {
        trailers = null;
      }
      if (!trailers || !trailers.positions.size) continue;

      // The un-stamped, non-terminal positions on the DB side. Refetch through the specs-table SDK — SpecCard's
      // `SpecPhase` drops the `position` column (it's an ordered array), and `stampPhaseBuilt` keys off the
      // canonical DB `position` (positions may be non-contiguous after a phase drop/re-authoring, so index+1
      // isn't safe). One extra read per candidate, and the candidate set is already narrowly filtered above.
      let specRow: Awaited<ReturnType<typeof getSpec>>;
      try {
        specRow = await getSpec(workspaceId, s.slug);
      } catch {
        continue;
      }
      if (!specRow) continue; // spec vanished between the roadmap read and now — leave it
      const unstamped = specRow.phases
        .filter((p) => p.status !== "shipped" && p.status !== "rejected" && !p.build_sha)
        .map((p) => p.position);
      const toStamp = unstamped.filter((pos) => trailers!.positions.has(pos));
      if (!toStamp.length) continue;

      // Step 7 (final gate): re-read isSpecAccumulationComplete NOW. It fails OPEN on a PM-read error (returns
      // complete:true) — that's fine here: an "open" reads as "not the wedge shape" and we skip. A live wedge
      // reads complete:false with the offending positions in `reason` — that's the shape we act on.
      let acc: { complete: boolean; reason: string };
      try {
        acc = await isSpecAccumulationComplete(workspaceId, s.slug);
      } catch {
        continue;
      }
      if (acc.complete) continue; // not wedged in the DB (or the read failed → fail-open) — leave it alone

      // Stamp each wedged position from the branch head — the SAME leaf write P1 uses at finalize time.
      const stamped: number[] = [];
      for (const pos of toStamp.sort((a, b) => a - b)) {
        try {
          await stampPhaseBuilt(workspaceId, s.slug, pos, { build_sha: trailers.headSha });
          stamped.push(pos);
        } catch {
          /* per-position best-effort — a single-phase write failing must not block the rest; next pass retries */
        }
      }
      if (!stamped.length) continue;
      result.unwedged.push({ slug: s.slug, branch, positions: stamped, headSha: trailers.headSha });

      // Surface the heal — one director_activity row per unwedged spec (never silent — supervisable autonomy).
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM,
        actionKind: "unwedged_stuck_accumulation",
        specSlug: s.slug,
        reason: `Unwedged stuck accumulation: ${s.slug} — branch ${branch} carried Phase: trailer(s) for position(s) ${stamped.join(", ")} but their build_sha was NULL and NO open PR existed, so isSpecAccumulationComplete permanently reported the spec incomplete and the PR never opened (the P1 wedge signature). Stamped ${stamped.length} phase(s) built from branch head ${trailers.headSha.slice(0, 8)} so the next finalize/promote tick opens the PR autonomously. Defense-in-depth for the accumulation-stamp-gap: P1 catches this at finalize time; this catches a run that already terminated with the wedge in place.`,
        metadata: {
          lane: "stuck_accumulation_backstop",
          branch,
          head_sha: trailers.headSha,
          stamped_positions: stamped,
          autonomous: true,
        },
      }).catch(() => {
        /* audit is best-effort — the stamp already landed */
      });
    } catch {
      // per-spec best-effort — one spec's failure never blocks the rest (the reactive chain + P1 finalize)
    }
  }
  return result;
}

/** The Max `claude -p` grooming prompt — read-only assess one partially-shipped spec → one JSON verdict. */
export function groomInvestigationPrompt(c: GroomCandidate): string {
  return [
    "You are Ada — the Platform/DevOps Director for ShopCX, running on Max (read-only prod DB + the brain, no API key).",
    "You GROOM the project board so nothing rots half-built. This spec is PARTIALLY shipped: some phases ✅,",
    "some ⏳ remain, and NO active build. Decide what to do with the leftover ⏳ phase(s):",
    "",
    "1. CONTINUE — the next ⏳ phase is NEEDED NOW: the spec's CURRENT promise (its H1 / its ## Verification)",
    "   requires it, or a dependent spec / a goal needs it now. → I queue its build to completion.",
    "2. SPLIT — the leftover ⏳ phase(s) are future enhancement / polish / \"someday\" the spec does NOT need to",
    "   be useful today. → I author EACH as its own planned card and CLOSE OUT the parent (remove those phases",
    "   so every remaining parent phase is ✅ and the parent folds). Future work is PRESERVED as a planned card,",
    "   never dropped.",
    "3. ESCALATE — genuinely unsure / high-stakes (could this be load-bearing?). → I escalate to the CEO and",
    "   move nothing. Prefer this over a wrong guess (north-star: hit a rail → escalate).",
    "4. FOLD_NOW — the remaining ⏳ phase(s) are PHANTOM: the work already landed (via another shipped spec),",
    "   OR a parser miscount counted a non-phase as a phase (e.g. a `### Phase N` inside `## Verification`",
    "   parsed as a real phase). → I flip every remaining phase to ✅ in spec_card_state (actor=director:platform,",
    "   reason logged to spec_status_history) and queue a fold via the existing fold chain. Reversible via the",
    "   CEO drift-reconciler. REQUIRES owner=platform (rejected otherwise → I escalate).",
    "5. AUTHOR_FOLLOWUP_SPEC — the investigation surfaced a real CODE-LEVEL root cause that is a SEPARATE spec",
    "   (a parser bug, a broken library, a missing tool — NOT just a future phase of THIS spec). → I AUTHOR the",
    "   followup as its own planned spec card (to public.specs — a DB row, NOT a .md file), AND apply the immediate candidate's",
    "   PRIMARY disposition you choose (`fold_now` or `split`) in the same pass so the candidate doesn't re-fire.",
    "   The followup is a NEW spec for the root cause; it is NOT a split of THIS spec. REQUIRES owner=platform.",
    "6. DISMISS_CANDIDATE — the spec shouldn't have been groomed (false-alarm candidacy: not actionable today,",
    "   malformed, duplicate, or superseded). → I write a `groomed_dismissed` ledger row so the dedup keeps it",
    "   out of the next pass; no spec mutation.",
    "",
    `Spec: ${c.slug} — ${c.title}`,
    `Owner: ${c.owner ?? "—"} · Parent: ${c.parent ?? "—"}`,
    `Shipped phases (✅, with merge PR + SHA): ${c.shippedPhases.join(" · ") || "—"}`,
    // director-trust-phase-pr-provenance Phase 1: a tagless ✅ phase (status=shipped, no `pr`) is DRIFT SUSPECT —
    // the merge hook is the only authoritative `pr` writer, so we cannot prove the merge landed. Surface these
    // distinctly so you don't classify a partially-tagless spec as ready-to-fold (a fully-shipped spec is the
    // ONLY fold-ready state — every ✅ phase must carry its merge PR). If drift-suspect phases exist, the
    // RIGHT verdict is `escalate` (the CEO can audit via the request-audit lane) UNLESS the leftover ⏳
    // phases are genuinely phantom AND you can name which merge shipped each suspect phase.
    c.driftSuspectPhases.length
      ? `Drift-suspect phases (✅ but no merge PR AND no merge SHA — provenance missing): ${c.driftSuspectPhases.join(" · ")}`
      : "",
    `Remaining phases (⏳): ${c.remainingPhases.join(" · ") || "—"}`,
    c.failedBuilds ? `Note: ${c.failedBuilds} prior build attempt(s) failed${c.lastError ? ` (latest: ${c.lastError.slice(0, 300)})` : ""}.` : "",
    "",
    "Full spec markdown:",
    "----------------------------------------",
    c.raw,
    "----------------------------------------",
    "",
    "Investigate read-only (the spec's promise, the dependents/goals it serves, the leftover phases' scope).",
    "",
    "If you choose SPLIT, you MUST provide, for EACH leftover ⏳ phase, a complete new card AND the rewritten",
    "parent. Rules:",
    `- New card slug = "${c.slug}-<short-phase-slug>" (lowercase a-z 0-9 -, derived from the phase name).`,
    "- New card markdown MUST contain: an H1 title (NO status emoji — status is DB-driven); the SAME **Owner:**",
    "  and **Parent:** lines as the parent; a one-line note `Split from [[" + c.slug + "]] — not needed now: <reason>`",
    "  (the worker sets its deferred flag in the DB); and the phase's content + any verification, as a",
    "  `## Phase 1 — <name>` section (NO status emoji; re-number to start at 1).",
    "- Rewritten parent: REMOVE the split `## Phase` section(s); keep the H1 and every remaining phase section +",
    "  whatever Verification still applies. NO status emojis anywhere — the parent's status is reconciled in the",
    "  DB from its remaining phases (the markdown is content-only).",
    "",
    "If you choose FOLD_NOW: your `reasoning` MUST be ≥20 chars and explain WHY the leftover phases are phantom",
    "(which other spec shipped the work, or which parser miscount produced them).",
    "",
    "If you choose AUTHOR_FOLLOWUP_SPEC, you MUST provide:",
    "- `followup`: a complete new spec card { slug, title, owner, parent, content } — slug lowercase a-z 0-9 -,",
    "  must NOT equal " + c.slug + "; content MUST contain an H1 ending in ⏳, **Owner:** and **Parent:** lines,",
    "  and at least one `## Phase N — … ⏳` section.",
    "- `primary`: the immediate-candidate disposition — either `fold_now` (then `reasoning` doubles as the fold",
    "  reason, ≥20 chars) OR `split` (then ALSO provide `splits` and `parent_markdown`, same rules as the SPLIT",
    "  verdict above).",
    "",
    "Final message = ONLY one JSON object (no markdown):",
    '{"verdict":"continue","reasoning":"<why the next ⏳ phase is needed now>"}',
    '{"verdict":"split","reasoning":"<why the leftovers are future, not needed now>","splits":[{"phase_title":"<the ⏳ phase>","slug":"' + c.slug + '-<phase>","markdown":"<full new card markdown>","reason":"<not-needed-now reason>"}],"parent_markdown":"<full rewritten parent markdown, every phase ✅>"}',
    '{"verdict":"escalate","reasoning":"<why this is genuinely ambiguous / possibly load-bearing — needs the CEO>"}',
    '{"verdict":"fold_now","reasoning":"<≥20 chars: why the remaining ⏳ phase(s) are phantom — which other spec shipped them, or which parser miscount produced them>"}',
    '{"verdict":"author_followup_spec","reasoning":"<why the root cause is a separate spec>","followup":{"slug":"<root-cause-spec-slug>","title":"<title ending with ⏳>","owner":"platform","parent":"<parent wikilink>","content":"<full spec markdown with H1+⏳, Owner, Parent, ## Phase N — … ⏳>"},"primary":"fold_now"}',
    '{"verdict":"author_followup_spec","reasoning":"...","followup":{...},"primary":"split","splits":[...],"parent_markdown":"..."}',
    '{"verdict":"dismiss_candidate","reasoning":"<why this shouldn\'t have been a groom candidate — false alarm, not actionable today, malformed, duplicate, superseded>"}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** One split card the investigation proposes — a future phase becoming its own planned spec. */
export interface GroomSplit {
  phase_title?: string;
  slug?: string;
  markdown?: string;
  reason?: string;
}

/**
 * One followup spec card the investigation proposes — a NEW planned spec for a ROOT CAUSE the
 * investigation surfaced (e.g. a parser bug, a broken library, a missing tool). Distinct from a
 * split: a followup is NOT a future phase of the current candidate; it stands on its own. Shared
 * by the groom / init / repair-dismissal lanes (`author_followup_spec` verdict, Phase 1 & 2).
 */
export interface FollowupSpec {
  slug?: string;
  title?: string;
  owner?: string;
  parent?: string;
  content?: string;
}

/** The parsed grooming verdict (the box lane's `claude -p` JSON). */
export interface GroomVerdict {
  verdict?: string;
  reasoning?: string;
  splits?: GroomSplit[];
  parent_markdown?: string;
  /** `author_followup_spec` — the NEW root-cause spec to commit. */
  followup?: FollowupSpec;
  /** `author_followup_spec` — the immediate-candidate's primary disposition (`fold_now` or `split`). */
  primary?: string;
}

/** The minimum length of a `fold_now` / `dismiss_candidate` reason — a one-word "phantom" verdict is
 *  rejected and escalates instead (validator rail; prevents an unauditable flip / dismiss landing). */
export const DIRECTOR_VERDICT_MIN_REASON_LEN = 20;

/**
 * Validate the `fold_now` verdict — the candidate's leftover ⏳ phase(s) are PHANTOM and the box is
 * about to flip every remaining phase to ✅ + queue a fold. Same-shape leash as `validateGroomSplit`:
 * owner=platform (the chat-surface `spec-status` action rule), at least one phase set to flip, and a
 * substantive (≥20 char) reason. A malformed verdict escalates instead of mutating the board.
 */
export function validateFoldNow(c: GroomCandidate, v: GroomVerdict): { ok: true } | { ok: false; error: string } {
  if ((c.owner ?? PLATFORM) !== PLATFORM) return { ok: false, error: `spec owner (${c.owner ?? "—"}) is not platform — can't fold_now` };
  if (!c.remainingPhases.length) return { ok: false, error: "no remaining ⏳ phases to flip" };
  const reason = String(v.reasoning ?? "").trim();
  if (reason.length < DIRECTOR_VERDICT_MIN_REASON_LEN) return { ok: false, error: `fold_now reason is empty or under ${DIRECTOR_VERDICT_MIN_REASON_LEN} chars` };
  // director-trust-phase-pr-provenance Phase 1: fold_now ALSO flips the leftover ⏳ phases to ✅ in the DB
  // with no `pr` tag (director:platform actor), which would CREATE the very drift we just refused to skip
  // past. So fold_now is only safe when the CARD'S ALREADY-✅ phases all carry provenance — every drift
  // suspect must be resolved via the request-audit lane FIRST. If the suspect set is non-empty, escalate
  // instead of folding so the CEO can audit (the audit re-stamps real phases + drops phantom ones).
  if (c.driftSuspectPhases.length) {
    return {
      ok: false,
      error:
        `fold_now blocked: ${c.driftSuspectPhases.length} ✅ phase(s) are drift suspect (no merge PR + SHA): ` +
        `${c.driftSuspectPhases.join(", ")}. Resolve via request-audit before folding — fold_now would stamp ` +
        `more tagless ✅ phases on top of existing drift.`,
    };
  }
  return { ok: true };
}

/**
 * Validate an `author_followup_spec` followup — the NEW root-cause spec the box is about to commit.
 * Rejects: a missing/invalid slug, a slug colliding with the parent, an empty markdown body, a
 * markdown body missing an H1 / a ⏳ status marker / the **Owner:** / **Parent:** lines, and (when
 * supplied) a parent whose owner is not platform — the same chat-surface `spec-status` owner gate
 * as the rest of the leash. A malformed followup escalates instead of authoring a broken card.
 */
export function validateFollowupSpec(parentSlug: string, parentOwner: string | undefined, f: FollowupSpec | undefined): { ok: true } | { ok: false; error: string } {
  if (!f) return { ok: false, error: "author_followup_spec verdict with no followup card" };
  const slug = String(f.slug ?? "");
  const md = String(f.content ?? "");
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return { ok: false, error: `invalid followup slug "${slug}"` };
  if (slug === parentSlug) return { ok: false, error: "followup slug collides with the parent" };
  if (!md.trim()) return { ok: false, error: "followup spec content is empty" };
  if (!/^#\s+.+/m.test(md)) return { ok: false, error: "followup spec missing an H1" };
  if (!/[⏳]/.test(md)) return { ok: false, error: "followup spec missing a ⏳ (must be planned)" };
  if (!/\*\*Owner:\*\*/i.test(md)) return { ok: false, error: "followup spec missing **Owner:**" };
  if (!/\*\*Parent:\*\*/i.test(md)) return { ok: false, error: "followup spec missing **Parent:**" };
  if (!/##\s+Phase\s+\d/im.test(md)) return { ok: false, error: "followup spec has no `## Phase N — …` section" };
  if ((parentOwner ?? PLATFORM) !== PLATFORM) return { ok: false, error: `parent owner (${parentOwner ?? "—"}) is not platform — can't author a followup` };
  return { ok: true };
}

/**
 * Validate the `dismiss_candidate` verdict — the candidate shouldn't have been groomed/init'd and the
 * box is about to write a dedup ledger row so the next pass skips it. Same-shape leash as the others:
 * a substantive (≥20 char) reason so the activity row carries audit-grade context (the audit IS the
 * gate). A malformed verdict escalates instead of writing a no-op ledger row.
 */
export function validateDismissCandidate(v: GroomVerdict): { ok: true } | { ok: false; error: string } {
  const reason = String(v.reasoning ?? "").trim();
  if (reason.length < DIRECTOR_VERDICT_MIN_REASON_LEN) return { ok: false, error: `dismiss_candidate reason is empty or under ${DIRECTOR_VERDICT_MIN_REASON_LEN} chars` };
  return { ok: true };
}

/**
 * Validate the INIT-lane `dismiss_candidate` DISPOSITION (director-dismissal-disposes-by-reason). On top of
 * the base `validateDismissCandidate` reason check, the init lane requires the dismissal to also DISPOSE of
 * the spec so it never lingers as a stale "planned" phantom: either `fold_superseded` (auto-fold off the
 * board — must CITE a `superseding_ref`) or `escalate_rework` (route to the CEO inbox). A `fold_superseded`
 * with no concrete superseding reference is rejected — an unconfirmable supersede is NOT a fold (north star:
 * a judgment call escalates, it does not silently execute), so the lane treats a malformed disposition as an
 * escalate (it never silently folds). Returns the normalized disposition on success.
 */
export function validateInitDismissDisposition(
  v: InitVerdict,
): { ok: true; disposition: "fold_superseded" | "escalate_rework"; supersedingRef?: string } | { ok: false; error: string } {
  const base = validateDismissCandidate(v);
  if (!base.ok) return base;
  const disposition = String(v.disposition ?? "").trim();
  if (disposition === "fold_superseded") {
    const ref = String(v.superseding_ref ?? "").trim();
    if (ref.length < 3) return { ok: false, error: "fold_superseded requires a `superseding_ref` (the spec slug / code that already does this work)" };
    return { ok: true, disposition: "fold_superseded", supersedingRef: ref };
  }
  if (disposition === "escalate_rework") return { ok: true, disposition: "escalate_rework" };
  return { ok: false, error: `dismiss_candidate disposition must be "fold_superseded" or "escalate_rework" (got "${disposition || "—"}")` };
}

/**
 * Validate a SPLIT verdict before the box commits anything to `main` — the leash is hard, so a malformed
 * split NEVER lands (a broken board is worse than an un-groomed card). Checks: at least one split; each
 * split has a `{parentSlug}-…` slug, an H1, a ⏳, a Deferred note, and an Owner + Parent line;
 * and the rewritten parent is non-empty, still carries the parent's H1 title, and is ALL-✅ (folds — no ⏳/🚧
 * left). Returns `{ ok }` or `{ ok:false, error }` so the lane can escalate instead of committing garbage.
 */
export function validateGroomSplit(
  c: GroomCandidate,
  v: GroomVerdict,
  deriveSpecStatus: (raw: string) => SpecStatus,
): { ok: true } | { ok: false; error: string } {
  const splits = v.splits ?? [];
  if (!splits.length) return { ok: false, error: "split verdict with no split cards" };
  const slugRe = /^[a-z0-9-]+$/;
  for (const s of splits) {
    const slug = String(s.slug ?? "");
    const md = String(s.markdown ?? "");
    if (!slug || !slugRe.test(slug)) return { ok: false, error: `invalid split slug "${slug}"` };
    if (!slug.startsWith(`${c.slug}-`)) return { ok: false, error: `split slug "${slug}" must start with "${c.slug}-"` };
    if (slug === c.slug) return { ok: false, error: "split slug collides with the parent" };
    if (!/^#\s+.+/m.test(md)) return { ok: false, error: `split "${slug}" missing an H1` };
    if (!/[⏳]/.test(md)) return { ok: false, error: `split "${slug}" missing a ⏳ (must be planned)` };
    if (!/\*\*Deferred:\*\*/i.test(md)) return { ok: false, error: `split "${slug}" missing a **Deferred:** note` };
    if (!/\*\*Owner:\*\*/i.test(md) || !/\*\*Parent:\*\*/i.test(md)) return { ok: false, error: `split "${slug}" missing Owner/Parent` };
  }
  const parentMd = String(v.parent_markdown ?? "");
  if (!parentMd.trim()) return { ok: false, error: "split verdict with no rewritten parent" };
  if (!/^#\s+.+/m.test(parentMd)) return { ok: false, error: "rewritten parent missing an H1" };
  if (deriveSpecStatus(parentMd) !== "shipped") return { ok: false, error: "rewritten parent is not all-✅ (would not fold)" };
  // De-dup the split slugs among themselves.
  const seen = new Set<string>();
  for (const s of splits) {
    const slug = String(s.slug);
    if (seen.has(slug)) return { ok: false, error: `duplicate split slug "${slug}"` };
    seen.add(slug);
  }
  return { ok: true };
}

// ── Phase 2 (director-initialize-platform-specs-no-wait) — initiate unstarted non-fix specs ─────────
// The other lanes drive every STARTED or fix-shaped spec: escortApprovedGoals walks goal→milestone→spec
// trees, escortFixSpecs builds unstarted authored fix specs (Repair-signature), and groomBoard moves
// in-flight (≥1 ✅) specs. The remaining gap is an unblocked, UNSTARTED (0 ✅) spec that is NEITHER goal-linked
// NOR Repair-signed: fix-escort rejects it (no Repair-signature), the goal-walk can't see it (no goal), and
// grooming needs a ✅. The director may INITIATE any such spec it drives with NO waiting period (initiation has
// no prior build, so no cooldown applies) — but NEVER blindly. Like grooming, the decision is a read-only Max
// `claude -p` SOUNDNESS investigation (the spec is sound + in-scope — critical now that the director touches
// unfamiliar cross-domain specs) before any build is queued; a failed/ambiguous verdict ESCALATES to the CEO and
// queues nothing (CEO decision 2026-06-24: the investigation step is mandatory, same soundness rail as approval/groom).
//
// Owner-agnostic drive (CEO directive 2026-06-29 — Ada is the SOLE builder): the lane never gates on owner.
// ANY unblocked, non-deferred, unstarted spec is a candidate, ROUTED via the build-driver keystone —
// `platformDrivesSpec`: while Platform is live+autonomous, Ada drives EVERY spec regardless of owner (the owner
// is the requesting/operating department, not the build driver). A department going live+autonomous OPERATES its
// software + AUTHORS specs but never builds — its specs stay with Ada. Fail-safe: Platform dormant ⇒ builds wait
// on the CEO.
//
// Hard rails (unchanged): a spec that is part of an unstarted (0%) GOAL is NOT touched here — escortApprovedGoals
// already surfaces a zero-progress owned goal to the CEO as a new-goal call; a deferred spec is skipped (Phase 1);
// destructive/irreversible/multi-choice still escalate (the investigation's job). Dormant until live+autonomous.

/** Absolute per-pass safety ceiling on initiation `claude -p` investigations. The SATURATION TARGET
 *  ({@link idleBuildCapacity}, director-initiation-throughput Phase 1) normally binds first; this is the
 *  hard cap = the pool ceiling, so a single pass fills up to all 8 lanes (not the old fixed 4) but never
 *  investigates more specs than there are lanes to feed. */
export const PLATFORM_DIRECTOR_INIT_CAP = BUILD_POOL_CAPACITY;

/** An unblocked, unstarted, non-fix, non-goal spec the director drives — a candidate to initiate after a soundness check. */
export interface InitCandidate {
  slug: string;
  title: string;
  owner?: string;
  parent?: string;
  summary: string;
  plannedPhases: string[]; // titles of the ⏳ phases (what the build will carry to completion)
  raw: string; // the spec's full markdown — the soundness investigation reads it
  /** prior failed build attempts (no in-flight) — the loop-guard count the dispatch reads. */
  failedBuilds: number;
  lastError: string | null;
}

/** The init-lane escalation dedup keys for a spec (ambiguous-soundness + loop-guard). */
export function initEscalationKeys(slug: string): string[] {
  return [`init-unsure:${slug}`, `initguard:${slug}`];
}

/** The stable ledger key for a terminal init decision on a spec (dismiss_candidate / author_followup_spec).
 *  Distinct namespace from `init-unsure:` so a re-fire (CEO drops the dismiss; re-initiation later) is
 *  one ledger query away — mirrors `groomKey`. */
export function initKey(slug: string): string {
  return `init:${slug}`;
}

/**
 * Has this spec ALREADY had a TERMINAL init decision (ambiguous-soundness / loop-guard escalation, OR a
 * `dismiss_candidate` / `author_followup_spec` directive that meant "don't initiate")? After any of those
 * the spec is still unstarted + unblocked, so without this ledger dedup it would be re-investigated (a
 * wasted `claude -p`) and re-decided every pass. A successful INITIATE doesn't need this — its queued build
 * flips the spec in-flight, which findInitCandidates already excludes. Best-effort.
 */
export async function alreadyInitiated(admin: Admin, slug: string): Promise<boolean> {
  const { data } = await admin
    .from("director_activity")
    .select("action_kind, metadata")
    .eq("director_function", PLATFORM)
    .in("action_kind", ["escalated", "init_dismissed", "init_authored_spec"])
    .order("created_at", { ascending: false })
    .limit(1000);
  const escalationKeys = new Set(initEscalationKeys(slug));
  const ledgerKey = initKey(slug);
  return (data ?? []).some((r) => {
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    if (r.action_kind === "escalated") return escalationKeys.has(String(meta["dedupe_key"] ?? ""));
    return meta["init_key"] === ledgerKey;
  });
}

/**
 * Find the unblocked, UNSTARTED (0 ✅) specs the director DRIVES and may initiate this pass — the gap no
 * other lane covers: NOT Repair-signed (escortFixSpecs owns those), NOT goal-linked (the goal-walk / new-goal
 * escalation owns those), not opted out (`**Auto-build:** off`), no in-flight build, and not already
 * terminally escalated by this lane. Owner-agnostic (CEO directive 2026-06-29): any owner's spec qualifies, routed
 * via the build-driver keystone `platformDrivesSpec` — while Platform is live+autonomous Ada drives EVERY spec
 * regardless of owner (the owner is attribution, not the build driver). A NO-OP until Platform is live+autonomous (like
 * the escort). Capped at INIT_CAP per pass. Each candidate is still SOUNDNESS-investigated by the box lane before
 * any build — this only assembles the unblinded gap; it never queues.
 */
export async function findInitCandidates(admin: Admin): Promise<InitCandidate[]> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return []; // dormant until activation flips the flag
  const chart = await buildOrgChartGraph();
  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return [];

  const [{ specs }, filters] = await Promise.all([getRoadmap(), getRoadmapFilters()]);
  // director-trust-phase-pr-provenance Phase 1: the "already shipped, skip" check requires every phase to
  // carry a `pr` tag (the merge hook is the only authoritative writer). A tagless ✅ phase is DRIFT SUSPECT,
  // NOT proof the work landed — counting it as "started" would let init silently bypass a spec that hasn't
  // really begun. Use `isCardFullyShippedWithProvenance` instead of `status !== "shipped"`, and the
  // provenance-shipped count for the "unstarted" gate.
  const unstarted = specs.filter(
    (s) =>
      !isCardFullyShippedWithProvenance(s) && // really shipped means every phase has its merge PR + SHA
      s.status !== "deferred" && // parked — the initiation lane never starts a deferred spec (director-drives-all-specs-and-deferred-status Phase 1)
      // spec-goal-branch-pm-flow M2: "unstarted" = NO phase has BUILT (branch build_sha OR shipped). Under
      // branch-flow a phase builds on the spec branch (build_sha, in_progress) long before it earns a `pr`
      // tag (M5 promotion), so `provenanceShippedCount === 0` (pr-gated) would call a half-built branch-flow
      // spec "unstarted" and risk the init lane re-queuing it. `branchBuiltCount === 0` recognizes the
      // branch-built phase as started. (The per-candidate `state.inFlight` check below also dedups.)
      branchBuiltCount(s) === 0 && // unstarted — no phase built on the branch or shipped (tagless ✅ doesn't count)
      specReviewDone(s) && // no-max-on-unreviewed-specs (PRIMARY): NEVER init a spec that hasn't passed Vale spec-review — an in_review / un-vale-passed spec would queue a build (and run a Max soundness investigation) only to be bounced at the claim-gate, burning a Max session each pass. Vale must pass it first.
      s.autoBuild !== false && // owner opted out of auto-build → leave it under manual control
      !s.repairSignature && // a fix spec — escortFixSpecs owns it, never the feature-init lane
      platformDrivesSpec(s.owner, chart, autonomy) && // owner-agnostic: Ada is the sole builder, she drives every spec (CEO directive 2026-06-29)
      !s.blockedBy.some((b) => !b.cleared) && // still blocked → its auto-queue fires when its last blocker ships
      (filters.goalsBySpec[s.slug] ?? []).length === 0, // goal-linked → the goal-walk / new-goal escalation owns it
  );

  // Critical-first (director-executable-plans-and-priority): a `**Priority:** critical` spec is investigated +
  // queued ahead of normal Planned specs, within the per-pass cap. Stable for non-critical (preserves order).
  unstarted.sort((a, b) => (b.critical ? 1 : 0) - (a.critical ? 1 : 0));

  // Build-gate: while a directive gates builds until a spec ships, the init lane starts NOTHING but the gate
  // spec (so a fix lands before new feature work compiles). The gate spec is usually a fix (escortFixSpecs owns
  // it), so this typically yields an empty init list while gated — intended.
  const gate = await buildGate(admin, workspaceId, PLATFORM);
  const candidates = gate ? unstarted.filter((s) => s.slug === gate.gatedUntil || s.critical) : unstarted; // gate lets the gate spec + critical priority builds through

  // Saturation target (Phase 1): fill the idle lanes — investigate up to (pool ceiling − in-flight) specs,
  // not a fixed 4. Lanes full → 0 → enqueue nothing this pass; 2 idle → top up 2; 8 idle → fill all 8.
  const target = Math.min(PLATFORM_DIRECTOR_INIT_CAP, await idleBuildCapacity(admin, workspaceId));
  if (target <= 0) return [];

  const out: InitCandidate[] = [];
  for (const s of candidates) {
    if (out.length >= target) break;
    const state = await specBuildState(admin, workspaceId, s.slug);
    if (state.inFlight) continue; // a build is already carrying it — not "unstarted with no build"
    if (await alreadyInitiated(admin, s.slug)) continue; // already terminally escalated — don't re-investigate
    const got = await getSpec(s.slug);
    if (!got) continue;
    out.push({
      slug: s.slug,
      title: s.title,
      owner: s.owner,
      parent: s.parent,
      summary: s.summary,
      plannedPhases: s.phases.filter((p) => p.status === "planned").map((p) => p.title),
      raw: got.raw,
      failedBuilds: state.failedCount,
      lastError: state.lastError,
    });
  }
  return out;
}

/** The parsed init soundness verdict (the box lane's `claude -p` JSON). */
export interface InitVerdict {
  verdict?: string;
  reasoning?: string;
  /** `author_followup_spec` — the NEW root-cause/correct-scope spec to commit (Phase 2). */
  followup?: FollowupSpec;
  /**
   * `dismiss_candidate` disposition (director-dismissal-disposes-by-reason) — a dismissed spec must CLEAR the
   * pipeline, never linger as a stale "planned" board artifact. The dismissal is an LLM judgment, so it also
   * decides WHERE the spec goes:
   *   - `"fold_superseded"` — the spec's work is GENUINELY already implemented/shipped elsewhere (redundant /
   *      done). → the lane auto-FOLDS the spec off the board (`setSpecStatus(..., "folded")`), recording the
   *      superseding spec/code in `superseding_ref`. Choose this ONLY when confident + able to cite the
   *      superseder.
   *   - `"escalate_rework"` — malformed / premise-wrong / scope-ambiguous / needs the owner to fix-or-cut /
   *      anything you can't confidently call superseded. → the lane ESCALATES to the CEO ("dismissed — fix or
   *      cut"); the spec stays as-is but now sits in the inbox, not a silent phantom. THE DEFAULT when unsure
   *      (north star: a judgment call escalates, it does not silently execute).
   */
  disposition?: "fold_superseded" | "escalate_rework";
  /** `fold_superseded` only — the superseding spec slug / code reference that already does this spec's work
   *  (cited so the fold note + dismissal ledger record WHY it's redundant). Required for `fold_superseded`. */
  superseding_ref?: string;
}

/**
 * The Max `claude -p` SOUNDNESS investigation prompt — read-only assess ONE unstarted spec and decide whether
 * to INITIATE its build (it is sound + in-scope) or ESCALATE to the CEO. NEVER a blind build: this is the same
 * soundness rail as the approval / groom lanes (CEO decision 2026-06-24). Owner-agnostic (Phase 2) — the spec may
 * belong to ANOTHER department whose director isn't live yet, so you (the keystone) drive it; the soundness check
 * matters MORE for an unfamiliar cross-domain spec, so escalate rather than guess when out of your depth.
 */
export function initInvestigationPrompt(c: InitCandidate): string {
  const ownedByOther = (c.owner ?? PLATFORM) !== PLATFORM;
  return [
    "You are Ada — the Platform/DevOps Director for ShopCX, running on Max (read-only prod DB + the brain, no API key).",
    "This is a spec on the board that is UNSTARTED (0 phases shipped), unblocked, NOT a Repair-authored fix, and",
    `NOT part of any goal. It is owned by ${c.owner ?? "platform"}${ownedByOther ? " — another department whose director isn't live yet, so it routes UP to you (the keystone) to drive" : " (your own department)"}.`,
    "Per CEO policy you may INITIATE any spec you drive with no waiting period — but NEVER blindly. Investigate",
    "read-only and decide whether to kick off its build now.",
    "",
    "1. INITIATE — the spec is SOUND and IN-SCOPE: it is well-formed (a real ## Phase plan), its approach is",
    `   reasonable, it is additive / reversible, and it is genuinely buildable${ownedByOther ? " (and you understand this cross-domain area well enough to drive it soundly)" : ""}. → I queue its build,`,
    "   and the existing chain + auto-ship + fold carry its phases to completion.",
    "2. ESCALATE — anything you cannot confirm sound: it is ambiguous / under-specified / possibly out of scope,",
    "   it implies a destructive or irreversible change, it is really a NEW GOAL (a large new product capability)",
    "   rather than a scoped spec, or it is a non-binary CHOICE. → I escalate to the CEO and queue NOTHING.",
    "   Prefer this over a wrong guess (north-star: hit a rail → escalate).",
    "3. AUTHOR_FOLLOWUP_SPEC — the spec describes a real need, but the RIGHT SCOPE is a DIFFERENT spec (this",
    "   one's framing is wrong, or its scope is too broad/narrow). → I COMMIT the correctly-scoped followup as",
    "   its own planned card AND dismiss THIS candidate so it doesn't re-fire. The followup is a NEW spec; the",
    `   ${ownedByOther ? "current candidate's owner must be platform for me to author (chat-surface spec-status owner rule)" : "owner gate is satisfied"}.`,
    "4. DISMISS_CANDIDATE — the spec shouldn't have been initiated (malformed, duplicate, superseded, or not",
    "   actionable today). I write a `init_dismissed` ledger row so the dedup keeps it out of the next pass, AND",
    "   a dismissed spec must CLEAR the pipeline (never linger on the board as a phantom \"planned\" artifact), so",
    "   you ALSO pick a `disposition` that decides where it goes:",
    "     • `fold_superseded` — the spec's work is GENUINELY already implemented / shipped elsewhere (redundant /",
    "       done). → I auto-FOLD the spec off the board and record the superseder. Pick this ONLY when you are",
    "       confident the work truly already exists AND you can CITE the superseding spec slug or code (set",
    "       `superseding_ref`). Don't fold on a hunch.",
    "     • `escalate_rework` — malformed / premise-wrong / scope-ambiguous / the owner must fix-or-cut it / you",
    "       can't confidently call it superseded. → I escalate to the CEO (\"dismissed — fix or cut\"); the spec",
    "       stays put but lands in the inbox, not a silent phantom. This is the DEFAULT whenever you're unsure",
    "       (north-star: a judgment call escalates, it does not silently execute).",
    "",
    `Spec: ${c.slug} — ${c.title}`,
    `Owner: ${c.owner ?? "—"} · Parent: ${c.parent ?? "—"}`,
    c.summary ? `Summary: ${c.summary}` : "",
    `Planned phases (⏳): ${c.plannedPhases.join(" · ") || "—"}`,
    c.failedBuilds ? `Note: ${c.failedBuilds} prior build attempt(s) failed${c.lastError ? ` (latest: ${c.lastError.slice(0, 300)})` : ""}.` : "",
    "",
    "Full spec markdown:",
    "----------------------------------------",
    c.raw,
    "----------------------------------------",
    "",
    "Investigate read-only (the spec's promise + phases, the code/tables it touches, whether it's a sound, scoped, buildable spec).",
    "",
    "If you choose AUTHOR_FOLLOWUP_SPEC, you MUST provide:",
    "- `followup`: a complete new spec card { slug, title, owner, parent, content } — slug lowercase a-z 0-9 -,",
    "  must NOT equal " + c.slug + "; content MUST contain an H1 ending in ⏳, **Owner:** and **Parent:** lines,",
    "  and at least one `## Phase N — … ⏳` section.",
    "If you choose DISMISS_CANDIDATE: your `reasoning` MUST be ≥20 chars and explain why this candidate",
    "shouldn't have been initiated (malformed / duplicate / superseded / not actionable today), AND you MUST set",
    "`disposition` to either \"fold_superseded\" or \"escalate_rework\". For \"fold_superseded\" you MUST ALSO set",
    "`superseding_ref` to the spec slug or code reference that already does this spec's work — an unconfirmable",
    "supersede (no concrete reference) is an \"escalate_rework\", not a fold. When in doubt, choose \"escalate_rework\".",
    "",
    "Final message = ONLY one JSON object (no markdown):",
    '{"verdict":"initiate","reasoning":"<why the spec is sound, in-scope, and safe to build now>"}',
    '{"verdict":"escalate","reasoning":"<why this needs the CEO — ambiguous / out of scope / a new goal / destructive / a choice>"}',
    '{"verdict":"author_followup_spec","reasoning":"<why the right scope is a different spec>","followup":{"slug":"<correctly-scoped-spec-slug>","title":"<title ending with ⏳>","owner":"platform","parent":"<parent wikilink>","content":"<full spec markdown>"}}',
    '{"verdict":"dismiss_candidate","disposition":"fold_superseded","superseding_ref":"<spec-slug-or-code-reference that already does this work>","reasoning":"<≥20 chars: why this candidate is genuinely already shipped elsewhere>"}',
    '{"verdict":"dismiss_candidate","disposition":"escalate_rework","reasoning":"<≥20 chars: why this candidate shouldn\'t have been initiated — malformed / premise-wrong / scope-ambiguous / owner must fix-or-cut>"}',
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Phase 1 (director-supervised-repair-dismissal) — supervise + dismiss Rafa's no-fix items ───────
// The CEO used to manually Dismiss every Control Tower warning where the Repair Agent (Rafa) declined to
// propose a fix (a `needs-human` verdict — a `repair` agent_jobs row parked in `needs_attention`, surfaced
// Dismiss-only by getOpenRepairs). This lane is the director SUPERVISING that no-fix call: she does NOT
// auto-dismiss noise — she adversarially RE-CHECKS Rafa's verdict and dismisses ONLY what she can
// independently confirm is benign. Anything she can't confirm stays up; a suspected masked real bug escalates.
//
// It reuses the EXISTING Dismiss plumbing (the owner path POST /api/developer/control-tower/repair, the
// `repair_build` action `declined` → resolve the error_events row + complete the job) — no new dismiss
// machinery, no migration. Like grooming/initiation, the JUDGMENT is a read-only Max `claude -p` in the box
// lane (builder-worker `superviseRepairDismissals`); this module is the mechanical half — find the candidates,
// build the prompt, dispatch the verdict, and the dedup ledger so each item is reviewed once.
//
// Leash: dismissing a confirmed-benign monitoring warning is the `monitoring_fix` class — low-risk and
// reversible (dismissing UN-blocks re-enqueue, so a wrongly-dismissed real problem re-fires and Rafa
// re-triages it). Unsure ⇒ escalate, never dismiss. NEVER dismisses a `real-bug` / fix-proposed item:
// findRepairDismissalCandidates only takes `needs-human` items and applyDirectorDismissal re-asserts the
// job is still `needs_attention` before clearing it.

/** Cap how many of Rafa's open no-fix items one supervision pass reviews (bound the per-pass `claude -p` cost). */
export const PLATFORM_DIRECTOR_DISMISS_CAP = 6;

/** The stable dedup key for a director review of one repair item — `dismiss:{signature}` (per the spec ledger). */
export function dismissKey(signature: string): string {
  return `dismiss:${signature}`;
}

/**
 * The stable dedup key for the EXTERNAL-BLOCKER CEO escalation of one signature — `external:{signature}`
 * (director-zero-backlog-error-autonomy Phase 2). Distinct from `dismiss:{signature}` (a suspected-real-bug
 * contrary diagnosis) so the two CEO touches never collide on one notification: an external break is a
 * BUSINESS call (wait/swap/degrade), not a code defect. Deduped per signature so the CEO pings once.
 */
export function externalBlockerKey(signature: string): string {
  return `external:${signature}`;
}

/** One of Rafa's open no-fix items the director may review — its job, signature, and his logged reasoning. */
export interface RepairDismissalCandidate {
  jobId: string;
  /** the error_events signature / `loop:<id>` (the repair job's spec_slug) — the dismiss-key anchor. */
  signature: string;
  /** short label of the originating error/alert. */
  title: string;
  /** Rafa's plain-text no-fix verdict + root-cause diagnosis (the job's log_tail) — what Ada re-checks. */
  rafaReasoning: string;
  createdAt: string;
}

/** The parsed supervision verdict (the box lane's `claude -p` JSON). */
export interface RepairDismissalVerdict {
  verdict?: string;
  reasoning?: string;
  /** For the `external` verdict (Phase 2): 2–3 concrete alternative options the CEO can choose (wait/retry, swap provider, degrade gracefully). */
  alternatives?: string[];
  /** For the `author_followup_spec` verdict (director-judgment-lanes-fold-author-dismiss Phase 2): the
   *  NEW fix spec to commit when Rafa mislabeled a REAL bug as needs-human. The item is kept (not
   *  dismissed) — the fix lands as its own card, and the existing build chain takes it from there. */
  followup?: FollowupSpec;
}

/**
 * Has the director ALREADY reviewed THIS repair job? Keyed on the job id (carried in every review row's
 * metadata.repair_job_id) so "reviewed once" holds for the SAME item — a `dismiss` completes the job (it
 * leaves getOpenRepairs), but a `keep`/`escalate`/`author_followup_spec` leaves it `needs_attention`, so
 * without this dedup it would be re-investigated every pass. A re-fire is a NEW job (new id) → a fresh
 * review, exactly as the spec wants. Matches the four review action_kinds (`dismissed_repair` /
 * `kept_repair` / `escalated` / `repair_authored_spec`). Best-effort.
 */
export async function alreadyReviewedDismissal(admin: Admin, jobId: string): Promise<boolean> {
  const { data } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("director_function", PLATFORM)
    .in("action_kind", ["dismissed_repair", "kept_repair", "escalated", "repair_authored_spec"])
    .order("created_at", { ascending: false })
    .limit(1000);
  return (data ?? []).some((r) => (r.metadata as Record<string, unknown> | null)?.["repair_job_id"] === jobId);
}

/**
 * Find Rafa's open no-fix items the director may review this pass — the `needs-human` bucket from
 * getOpenRepairs (a `repair` job in `needs_attention`, Dismiss-only). NEVER a `needs_approval` fix-proposed
 * item and NEVER a `real-bug` (those carry a proposed spec → `state === "proposed"`, excluded here). Skips
 * an item this director already reviewed. A NO-OP until Platform is live+autonomous (dormant until activation,
 * like the escort/groom/init lanes). Capped at DISMISS_CAP per pass. Each candidate is still adversarially
 * re-checked by the box lane's `claude -p` before any dismissal — this only assembles the bucket; it never clears.
 */
export async function findRepairDismissalCandidates(admin: Admin): Promise<RepairDismissalCandidate[]> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return []; // dormant until activation flips the flag
  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return [];

  const open = await getOpenRepairs(admin, workspaceId);
  const needsHuman = open.filter((r) => r.state === "needs-human"); // never a proposed-fix / real-bug item

  const out: RepairDismissalCandidate[] = [];
  for (const r of needsHuman) {
    if (out.length >= PLATFORM_DIRECTOR_DISMISS_CAP) break;
    if (await alreadyReviewedDismissal(admin, r.jobId)) continue; // reviewed once (a re-fire is a new job)
    out.push({ jobId: r.jobId, signature: r.signature, title: r.title, rafaReasoning: r.diagnosis, createdAt: r.createdAt });
  }
  return out;
}

/** The Max `claude -p` supervision prompt — read-only re-derive the root cause + adversarially test Rafa's no-fix call. */
export function repairDismissalInvestigationPrompt(c: RepairDismissalCandidate): string {
  return [
    "You are Ada — the Platform/DevOps Director for ShopCX, running on Max (read-only prod DB + the brain, no API key).",
    "Rafa (the Repair Agent — a tool you supervise) looked at this Control Tower error and declined to propose a fix:",
    "he classified it `needs-human` (no fix spec, parked for a manual Dismiss). Your job is NOT to rubber-stamp him.",
    "Rafa optimizes the bounded proxy 'clear the error'; the degenerate state is clearing a warning by declaring a",
    "REAL bug benign. So adversarially RE-CHECK his no-fix call: independently re-derive the root cause and decide.",
    "",
    "DEFAULT TO NOT DISMISSING. Emit `dismiss` ONLY if you can INDEPENDENTLY confirm the error is genuinely",
    "transient (a flake / one-off / already-recovered), foreign (a third-party app's OWN noise that does not break",
    "OUR functionality), or otherwise benign — AND is NOT a masked real bug. If you cannot confirm that, do NOT dismiss.",
    "",
    "1. DISMISS — you independently confirmed it is genuinely transient / foreign-app-noise / benign (not a masked",
    "   real bug, NOT an external dependency WE rely on breaking). → I clear the warning via the existing Dismiss path",
    "   (resolve the error + complete the item). This is low-risk + reversible: a dismissed item un-blocks re-enqueue,",
    "   so if it really was real it re-fires and Rafa re-triages it.",
    "2. ESCALATE — you SUSPECT Rafa mislabeled a REAL bug as benign (your independent root-cause says it's a genuine",
    "   defect in OUR code that we can fix). → I do NOT dismiss; I escalate to the CEO with your contrary diagnosis.",
    "3. EXTERNAL — your verified root cause is OUTSIDE our system: a third-party API contract change, a vendor outage",
    "   BEYOND our retry/breaker, or a credential/permission change on THEIR side. It is NOT fixable in our code — it",
    "   needs a BUSINESS call. → I do NOT author a code fix; I escalate it to the CEO with your diagnosis + 2–3 concrete",
    "   ALTERNATIVE options (e.g. wait/retry the vendor, swap to another provider, degrade that path gracefully). This",
    "   is the ONLY routine error escalation that reaches the CEO — everything internally-fixable I handle without them.",
    "4. KEEP — it is a genuine needs-human call you can neither confirm benign, NOR confidently call a real bug in OUR",
    "   code, NOR confirm is an external break. → I leave it on the Control Tower untouched for the human to decide.",
    "   Prefer this over a wrong dismiss (north-star: hit a rail → escalate, never execute).",
    "5. AUTHOR_FOLLOWUP_SPEC — Rafa's no-fix item is a REAL bug he miscategorized: your independent root-cause says",
    "   it IS our code defect AND you can scope the fix as a concrete spec. → I author the fix as its own planned",
    "   spec (to public.specs — a DB row, NOT a .md file) and KEEP the item open on the Control Tower so the fix's build retires",
    "   it. This is the constructive alternative to `escalate` — the spec IS the proposed fix; the build chain",
    "   takes it from there. Use this ONLY when you can write a real, scoped fix; otherwise prefer `escalate`.",
    "",
    `Error signature: ${c.signature}`,
    `Label: ${c.title}`,
    "",
    "Rafa's logged no-fix reasoning:",
    "----------------------------------------",
    c.rafaReasoning || "(no diagnosis logged)",
    "----------------------------------------",
    "",
    "Investigate read-only: load the originating error_events / loop_alerts sample for this signature, read the",
    "implicated code/library/integration in the brain, and INDEPENDENTLY re-derive the root cause. Test Rafa's call",
    "adversarially — could a real bug be hiding behind a 'transient'/'foreign' label? Your reasoning must be YOUR",
    "OWN independent diagnosis, not a restatement of Rafa's.",
    "",
    "If you choose AUTHOR_FOLLOWUP_SPEC, you MUST provide a `followup` card { slug, title, owner, parent,",
    "content } — slug lowercase a-z 0-9 -; content with H1+⏳, **Owner:** (must be platform), **Parent:**, and",
    "at least one `## Phase N — … ⏳` section. The spec IS the proposed code fix.",
    "",
    "Final message = ONLY one JSON object (no markdown):",
    '{"verdict":"dismiss","reasoning":"<your INDEPENDENT confirmation it is genuinely transient/foreign-noise/benign and not a masked real bug>"}',
    '{"verdict":"escalate","reasoning":"<your contrary diagnosis — why this looks like a real bug in OUR code Rafa mislabeled benign>"}',
    '{"verdict":"external","reasoning":"<your verified diagnosis that the root cause is an external dependency break, not OUR code>","alternatives":["wait/retry …","swap provider …","degrade gracefully …"]}',
    '{"verdict":"keep","reasoning":"<why this is a genuine needs-human call you can neither confirm benign, call a real bug, nor confirm external>"}',
    '{"verdict":"author_followup_spec","reasoning":"<your independent root-cause: this IS a real bug in our code that I can scope as a fix>","followup":{"slug":"<fix-spec-slug>","title":"<title ending with ⏳>","owner":"platform","parent":"<parent wikilink, e.g. [[../functions/platform]]>","content":"<full spec markdown>"}}',
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Dismiss ONE of Rafa's no-fix items — the autonomous director path through the EXISTING owner Dismiss
 * plumbing (mirrors POST /api/developer/control-tower/repair `dismiss`, minus the owner auth gate): decline
 * the `repair_build` action (if any), complete the job, and resolve the originating error_events row. Then
 * write a `dismissed_repair` director_activity row carrying ADA'S OWN independent reasoning (not a copy of
 * Rafa's) + the dedup key. HARD GUARD: re-asserts the job is still `needs_attention` before clearing it, so a
 * real-bug / fix-proposed item that flipped to `needs_approval` is never dismissed. Best-effort; returns {ok}.
 */
export async function applyDirectorDismissal(
  admin: Admin,
  candidate: RepairDismissalCandidate,
  reasoning: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: job } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, spec_slug, status, pending_actions")
    .eq("id", candidate.jobId)
    .eq("kind", "repair")
    .maybeSingle();
  if (!job) return { ok: false, error: "repair job not found" };
  // Never dismiss a real-bug / fix-proposed item: only a still-open needs-human item (needs_attention) clears.
  if (job.status !== "needs_attention") return { ok: false, error: `repair job is ${job.status}, not a needs-human item` };

  const actions = Array.isArray(job.pending_actions) ? (job.pending_actions as Array<Record<string, unknown>>) : [];
  const next = actions.map((a) => (a.type === "repair_build" ? { ...a, status: "declined" } : a));
  const { error } = await admin
    .from("agent_jobs")
    .update({ status: "completed", pending_actions: next, error: "dismissed by Ada (Platform/DevOps Director)", updated_at: new Date().toISOString() })
    .eq("id", job.id);
  if (error) return { ok: false, error: error.message };

  // Resolve the originating error_events row (the repair job's spec_slug IS the error signature, e.g. "vercel:…")
  // with a recorded reason — terminal (fix-error-reconcile-endless-loop Phase 1).
  if (job.spec_slug) {
    await admin
      .from("error_events")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_reason: `dismissed by Ada (Platform/DevOps Director): ${reasoning}`.slice(0, 2000) })
      .eq("signature", job.spec_slug);
  }

  await recordDirectorActivity(admin, {
    workspaceId: job.workspace_id as string,
    directorFunction: PLATFORM,
    actionKind: "dismissed_repair",
    specSlug: null,
    reason: reasoning,
    metadata: { dismiss_key: dismissKey(candidate.signature), repair_job_id: job.id, signature: candidate.signature, title: candidate.title, verdict: "dismiss", autonomous: true },
  });
  return { ok: true };
}

// ── director-judgment-lanes-fold-author-dismiss (Phase 1 + 2) — shared cross-lane action helper ─────
// Every read-only Max judgment lane (groom · init · repair-dismissal) returns the SAME three new
// action types when a sound diagnosis exits the lane's native verdict set. This module hosts the
// reversible DB-only halves (fold_now phase flip + enqueue_fold; dismiss_candidate ledger row) +
// the followup-spec DB AUTHORING (author_followup_spec → public.specs via authorSpecRowFromMarkdown;
// the in-memory followup markdown is the INPUT, no .md file is written). Each lane keeps its own native
// verdicts (continue/split for groom, initiate for init, dismiss for repair) — these helpers ONLY handle
// the three new cross-lane actions.

/** Which read-only judgment lane is dispatching the action — drives the lane-specific dedup key
 *  (groom_key / init_key / dismiss_key) and the activity-row `action_kind` (groomed_* / init_* /
 *  repair_*). */
export type DirectorLane = "groom" | "init" | "repair-dismissal";

/** The lane-specific dedup ledger key for an action on `slug`/`signature` — looked up by each lane's
 *  `alreadyGroomed`/`alreadyInitiated`/`alreadyReviewedDismissal` to skip the same candidate next pass.
 *  groom + init are spec-keyed; repair-dismissal is signature-keyed. */
function laneLedgerKey(lane: DirectorLane, slug: string | null | undefined, signature: string | undefined): { name: string; value: string } {
  if (lane === "groom") return { name: "groom_key", value: groomKey(slug ?? "") };
  if (lane === "init") return { name: "init_key", value: initKey(slug ?? "") };
  return { name: "dismiss_key", value: dismissKey(signature ?? "") };
}

/** A typed action description handed to the shared dispatch helpers. The worker resolves the verdict's
 *  JSON shape into one of these (with the followup body, the fold reason, or the dismiss reason). */
export type DirectorActionInput =
  | { type: "fold_now"; reason: string }
  | { type: "author_followup_spec"; followup: FollowupSpec; reason: string }
  | { type: "dismiss_candidate"; reason: string };

/**
 * Flip every leftover ⏳ phase of a partially-shipped spec to ✅ (status → `shipped` in spec_card_state,
 * actor=director:platform, reason → spec_status_history) AND queue a fold via the existing fold chain
 * (`enqueue_fold` RPC — same path the manual "Mark verified & archive" tap uses), AND write the
 * `groomed_fold_now` director_activity row carrying `{slug, flipped_phases, reason}`. Same DB-only
 * surface as `routeAlreadyShipped` in needs-attention-route.ts (the already-shipped park class). Caller
 * is the GROOM lane's dispatch (Phase 1) — the only lane where fold_now applies (init/repair candidates
 * have nothing to fold). Idempotent: alreadyGroomed dedups via groom_key on the activity row.
 *
 * Pre-condition: `validateFoldNow(c, v)` returned ok. The card flip is best-effort (markSpecCardStatus
 * swallows errors); a missing card is logged but does not block enqueue_fold + the activity row.
 */
export async function applyDirectorFoldNow(
  admin: Admin,
  workspaceId: string,
  c: GroomCandidate,
  reason: string,
): Promise<{ ok: boolean; error?: string; flippedPhases: number[] }> {
  // derive-rollup-status: flip the leftover phases on the CANONICAL `spec_phases` table (not just the
  // spec_card_state mirror) — the board status derives from `spec_phases`, so the rollup only reads `shipped`
  // once the canonical phases are shipped. The DB trigger rolls `specs.status` → shipped from this write; no
  // direct card-status write needed (that path is retired).
  let flippedPositions: number[] = [];
  try {
    const { markRemainingPhasesShipped } = await import("@/lib/specs-table");
    flippedPositions = await markRemainingPhasesShipped(workspaceId, c.slug);
  } catch (e) {
    console.warn(`[platform-director] applyDirectorFoldNow: markRemainingPhasesShipped failed for ${c.slug}:`, e instanceof Error ? e.message : e);
  }
  // `flippedPhases` is 0-based for the activity row's metadata; map from the 1-based phase positions.
  const flippedPhases: number[] = flippedPositions.map((pos) => pos - 1);
  // Queue the fold via the existing RPC — coalesces into the next batch fold-build automatically.
  const { error } = await admin.rpc("enqueue_fold", { p_workspace: workspaceId, p_slug: c.slug, p_user: null });
  if (error) return { ok: false, error: error.message, flippedPhases };

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: PLATFORM,
    actionKind: "groomed_fold_now",
    specSlug: c.slug,
    reason,
    metadata: {
      groom_key: groomKey(c.slug),
      flipped_phases: flippedPhases,
      remaining_phase_titles: c.remainingPhases,
      // Cross-dept stamp (director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive
      // Phase 1) — the OWNING function, so the watch line can count the keystone covering cross-dept work.
      owner_function: c.owner ?? null,
      autonomous: true,
    },
  });
  return { ok: true, flippedPhases };
}

/**
 * Author the new followup spec straight to the DB (public.specs + public.spec_phases via
 * author-spec.authorSpecRowFromMarkdown — the in-memory followup markdown body is the INPUT; NO `.md`
 * file is written) AND write the lane-appropriate `*_authored_spec` director_activity row carrying the
 * dedup key for the CANDIDATE that produced it (groom_key / init_key / dismiss_key) + the followup slug.
 * The candidate's primary disposition (groom: fold_now|split · init: dismiss · repair-dismissal: keep) is
 * NOT applied here — the lane calls it separately so the same applyDirectorFoldNow / applyDirectorDismiss /
 * split machinery covers both the standalone-action path and the followup path.
 *
 * Post spec-pm-markdown-purge / db-driven-specs: the spec board reads public.specs (getRoadmap), so the
 * followup body MUST land there to render — and the repo no longer carries `docs/brain/specs/*.md`. This
 * mirrors the DB-driven split path (markNewSpecInReview → authorSpecRowFromMarkdown) the same lanes use.
 *
 * Pre-condition: `validateFollowupSpec(parentSlug, parentOwner, action.followup)` returned ok.
 */
export async function applyDirectorAuthorFollowup(
  admin: Admin,
  workspaceId: string,
  lane: DirectorLane,
  candidate: { slug: string | null; signature?: string; jobId?: string; owner?: string | null },
  followup: FollowupSpec,
  reason: string,
): Promise<{ ok: boolean; error?: string; authoredSlug: string; existed: boolean }> {
  const slug = String(followup.slug ?? "");
  const markdown = String(followup.content ?? "");

  // spec-pm-markdown-purge: existence is the DB spec row, not a file on main (a convergent re-author over
  // an already-tracked slug is treated as already authored — its card state is whatever the original
  // author left it). Matches the split path's `getSpec` existence check in the same lanes.
  const existing = await getSpec(slug, workspaceId);
  const existed = !!existing;
  if (!existed) {
    try {
      // Land the body in public.specs + public.spec_phases so the board / getRoadmap renders it. The
      // in-memory followup markdown is the INPUT; intended `planned` (the director only authors followups
      // she wants built).
      await authorSpecRowFromMarkdown(workspaceId, slug, markdown, "planned", {
        intendedStatusSetBy: `director:${PLATFORM}`,
      });
    } catch (e) {
      return { ok: false, error: `followup spec DB author failed: ${e instanceof Error ? e.message : String(e)}`, authoredSlug: slug, existed: false };
    }
    // spec-review-agent Phase 3 — a director-authored followup is a freshly-created spec; mark its card
    // `in_review` with `flags.intended_status='planned'`. Best-effort: a mirror-write failure is swallowed
    // (caller's `ok` doesn't gate on this).
    try {
      await markSpecCardForReview(workspaceId, slug, "planned", {
        actor: `director:${PLATFORM}`,
        reason: `${lane}: author_followup_spec — intended planned (director-authored followup)`,
      });
    } catch (e) {
      console.warn(`[platform-director] markSpecCardForReview failed for followup ${slug}:`, e instanceof Error ? e.message : e);
    }
  }
  const ledger = laneLedgerKey(lane, candidate.slug, candidate.signature);
  const actionKind = lane === "groom" ? "groomed_authored_spec" : lane === "init" ? "init_authored_spec" : "repair_authored_spec";
  const metadata: Record<string, unknown> = {
    [ledger.name]: ledger.value,
    followup_slug: slug,
    followup_title: String(followup.title ?? ""),
    followup_owner: String(followup.owner ?? ""),
    followup_parent: String(followup.parent ?? ""),
    existed,
    autonomous: true,
  };
  // director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive Phase 1: when the lane
  // knows the candidate spec's OWNING function (groom/init pass it; repair-dismissal has no spec owner),
  // stamp it so the daily watch can count cross-dept drives (the keystone covering a not-yet-live director).
  if (candidate.owner !== undefined) metadata.owner_function = candidate.owner ?? null;
  // Repair-dismissal lane: also carry repair_job_id so alreadyReviewedDismissal (job-id keyed) dedups it.
  if (lane === "repair-dismissal" && candidate.jobId) metadata.repair_job_id = candidate.jobId;
  if (lane === "repair-dismissal" && candidate.signature) metadata.signature = candidate.signature;
  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: PLATFORM,
    actionKind,
    specSlug: candidate.slug ?? null,
    reason,
    metadata,
  });
  return { ok: true, authoredSlug: slug, existed };
}

/**
 * Write the lane-appropriate `*_dismissed` director_activity row carrying the dedup key for the
 * candidate. No spec mutation, no markdown commit, no build queued — the row IS the audit. The dedup
 * ledger (`alreadyGroomed`/`alreadyInitiated`) reads its key on the next pass and skips the candidate.
 * Same shape as the existing `kept_repair` ledger row in the repair lane.
 *
 * Pre-condition: `validateDismissCandidate(v)` returned ok.
 */
export async function applyDirectorDismissCandidate(
  admin: Admin,
  workspaceId: string,
  lane: DirectorLane,
  candidate: { slug: string | null; signature?: string; owner?: string | null },
  reason: string,
  extraMetadata?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const ledger = laneLedgerKey(lane, candidate.slug, candidate.signature);
  const actionKind = lane === "groom" ? "groomed_dismissed" : lane === "init" ? "init_dismissed" : "repair_dismissed";
  const metadata: Record<string, unknown> = { [ledger.name]: ledger.value, autonomous: true, ...(extraMetadata ?? {}) };
  // director-drives-all-specs-and-deferred-status-board-reflects-cross-dept-drive Phase 1: stamp the
  // OWNING function when the lane knows it (groom/init pass it) so the daily watch's cross-dept count
  // covers the dismiss disposition too — every drive of a cross-dept spec leaves an owner-stamped row.
  if (candidate.owner !== undefined) metadata.owner_function = candidate.owner ?? null;
  const r = await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: PLATFORM,
    actionKind,
    specSlug: candidate.slug ?? null,
    reason,
    metadata,
  });
  return { ok: r.recorded, error: r.reason };
}

/**
 * director-dismissal-disposes-by-reason — the `fold_superseded` disposition of an init-lane dismissal: a spec
 * whose work is GENUINELY already shipped elsewhere is DISPOSED of, not left as a stale "planned" phantom. We
 * (1) FOLD the spec off the board via the specs-table SDK (`setSpecStatus(..., "folded")` — the override-only
 * status column; a folded spec is excluded from the board by `isBoardableStatus`, so `findInitCandidates`
 * never sees it again — the fold supersedes the dedup ledger rather than fighting it), and (2) write the SAME
 * `init_dismissed` ledger row the plain dismiss writes (so the existing dedup + audit are intact) — now ALSO
 * carrying `disposition: "fold_superseded"` + the cited `superseding_ref` in metadata + the fold note baked
 * into the reason. The fold is attempted FIRST and gates `ok`: if the SDK fold fails we do NOT write a ledger
 * row claiming the spec was cleared (so the next pass re-investigates rather than silently stranding it).
 *
 * Pre-condition: `validateInitDismissDisposition(v)` returned `{ disposition: "fold_superseded", supersedingRef }`.
 */
export async function applyDirectorFoldSuperseded(
  admin: Admin,
  workspaceId: string,
  candidate: { slug: string; owner?: string | null },
  supersedingRef: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  // Fold FIRST (the board-clearing mutation). If it throws, surface the error and write no ledger row.
  try {
    await setSpecStatus(workspaceId, candidate.slug, "folded", `director:${PLATFORM}`);
  } catch (e) {
    return { ok: false, error: `fold_superseded setSpecStatus failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const foldNote = `Superseded by ${supersedingRef} — work already shipped elsewhere; folded off the board. ${reason}`.slice(0, 4000);
  return applyDirectorDismissCandidate(admin, workspaceId, "init", { slug: candidate.slug, owner: candidate.owner ?? null }, foldNote, {
    disposition: "fold_superseded",
    superseding_ref: supersedingRef,
    folded: true,
  });
}

// ── ada-standing-pass-reasoning-gate Phase 4 — idle work-gate + adaptive cadence backoff ────────────
// Cheap EXISTS/COUNT sweep across every input the standing pass consumes. Fires BEFORE any lane so a
// truly-idle workspace (no directive, no drift, no non-terminal specs, no open errors/alerts, no
// stalled jobs, no stale coverage, no unresolved regressions) records a quiet beat and skips the pass
// entirely — returning the 5-hour Max window to real builds/repairs. The cron additionally reads the
// recent gate beats to back its enqueue cadence off from every-5-min → hourly across a solid idle span
// (any pending signal in the last `PLATFORM_STANDING_PASS_IDLE_MS` snaps it back to every-5-min).

/**
 * After this long without any pending signal, the cron backs the enqueue cadence off from every-5-min
 * to hourly. ANY pending signal inside this window snaps it back to every-5-min. Read at cron time to
 * gate the enqueue.
 */
export const PLATFORM_STANDING_PASS_IDLE_MS = 30 * 60 * 1000;

/** The `loop_heartbeats.loop_id` the cron writes for each workspace's per-tick gate beat. */
export function platformStandingPassGateLoopId(workspaceId: string): string {
  return `platform-standing-pass-gate:${workspaceId}`;
}

/** The one-line verdict from `platformHasPendingWork` — `pending=true` ⇒ the pass has real work to do. */
export interface PlatformPendingWorkResult {
  pending: boolean;
  reason: string;
}

/**
 * Cheap EXISTS/COUNT gate over everything the standing pass monitors. Returns `pending=true` on the
 * FIRST signal (cheap checks first, expensive last) so an idle workspace short-circuits after one
 * `.select("id").limit(1)`. A `pending=false` verdict means the pass can safely skip every lane this
 * tick — the box standing pass records a quiet beat and returns; the cron additionally uses it (plus
 * the recent gate-heartbeats window) to back its enqueue cadence off from every-5-min to hourly.
 *
 * Signals scanned:
 *  1. active [[director_directives]] for platform (headlines the pass + the daily watch)
 *  2. open [[spec_drift]] rows (the drift-supervision lane's input)
 *  3. [[agent_jobs]] `needs_attention` OR building > 90m (self-watch + park-route + backstop input)
 *  4. open [[error_events]] (reconcileErrorBacklog input)
 *  5. open [[loop_alerts]] (reconcileErrorBacklog input)
 *  6. non-terminal [[specs]] `in_review｜planned｜in_progress` (escort / init / groom input)
 *  7. [[goals]] `status='complete' + is_parent=false` (reconcileCompletedGoalsToFolded input)
 *  8. coverage past freshness — any shipped spec with no [[spec_test_runs]] row within
 *     `PLATFORM_DIRECTOR_REVERIFY_WINDOW_MS` (reconcileRegressionCoverage input)
 *  9. unresolved evidence-backed regression fails ([[../libraries/spec-test-runs]] `getHumanTestQueue` —
 *     reconcileRegressionBacklog input)
 *
 * A DB-only gate is sound because a GitHub-lane candidate (ready/dirty PR, READY branch) only exists
 * because a build job exists, which (3) captures; a rare orphan self-heals on the next non-idle pass.
 *
 * IMPORTANT scope: gates ONLY the box standing pass. The grading/coaching cascade keeps its own
 * `agentGradingBatchReady` gate ([[../inngest/platform-director-cron]] `grade-and-coach-workers`) and
 * is out of scope here — see spec `grading-cascade-to-box-sessions`.
 */
export async function platformHasPendingWork(workspaceId: string): Promise<PlatformPendingWorkResult> {
  const admin = createAdminClient();

  // (1) active directive — a live directive is a pending signal by itself (headlines every pass).
  {
    const { data } = await admin
      .from("director_directives")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("director_function", PLATFORM)
      .eq("status", "active")
      .limit(1);
    if (data?.length) return { pending: true, reason: "active director directive" };
  }

  // (2) open spec_drift rows — Ada's supervision lane input.
  {
    const { data } = await admin
      .from("spec_drift")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("status", "open")
      .limit(1);
    if (data?.length) return { pending: true, reason: "open spec_drift rows" };
  }

  // (3) any parked or long-running build — self-watch + park-route input.
  {
    const { data: parked } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("status", "needs_attention")
      .limit(1);
    if (parked?.length) return { pending: true, reason: "agent_jobs needs_attention" };
    const stalledCutoffIso = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const { data: stalled } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("status", "building")
      .lt("claimed_at", stalledCutoffIso)
      .limit(1);
    if (stalled?.length) return { pending: true, reason: "agent_jobs building >90m" };
  }

  // (4-5) open error backlog / open loop alerts — reconcileErrorBacklog input.
  {
    const { data: errs } = await admin.from("error_events").select("id").eq("status", "open").limit(1);
    if (errs?.length) return { pending: true, reason: "open error_events" };
    const { data: alerts } = await admin.from("loop_alerts").select("id").eq("status", "open").limit(1);
    if (alerts?.length) return { pending: true, reason: "open loop_alerts" };
  }

  // (6) any non-terminal spec — every drive lane's input. specs-status-overrides-only: the derived statuses
  // (in_review / planned / in_progress / shipped) all carry a NULL stored `status`; only the two terminal-ish
  // overrides (`deferred` / `folded`) are stored. So "non-terminal" = `status IS NULL` (a shipped-awaiting-fold
  // spec is intentionally included — it still feeds the spec-test / fold drive lanes).
  {
    const { data } = await admin
      .from("specs")
      .select("slug")
      .eq("workspace_id", workspaceId)
      .is("status", null)
      .limit(1);
    if (data?.length) return { pending: true, reason: "non-terminal specs" };
  }

  // (7) complete non-parent goals awaiting fold — reconcileCompletedGoalsToFolded input.
  {
    const { data } = await admin
      .from("goals")
      .select("slug")
      .eq("workspace_id", workspaceId)
      .eq("status", "complete")
      .eq("is_parent", false)
      .limit(1);
    if (data?.length) return { pending: true, reason: "complete non-parent goals" };
  }

  // (8) coverage past freshness — a shipped spec with no spec_test_runs in the window (or never).
  // specs-status-overrides-only: `shipped` is now DERIVED (no stored `status='shipped'`), so we proxy it via
  // merge provenance — a spec that has merged at least once carries `last_merge_sha` — among non-terminal
  // (`status IS NULL`) rows. This is a cheap DB-only wake gate (over-including a part-shipped spec is
  // harmless: the freshness filter below still gates, and the downstream reconcileRegressionCoverage
  // re-derives the true shipped set).
  try {
    const { data: shipped } = await admin
      .from("specs")
      .select("slug")
      .eq("workspace_id", workspaceId)
      .is("status", null)
      .not("last_merge_sha", "is", null)
      .limit(500);
    const shippedRows = (shipped ?? []) as Array<{ slug: string }>;
    if (shippedRows.length) {
      const cutoffIso = new Date(Date.now() - PLATFORM_DIRECTOR_REVERIFY_WINDOW_MS).toISOString();
      const { data: freshRuns } = await admin
        .from("spec_test_runs")
        .select("spec_slug")
        .eq("workspace_id", workspaceId)
        .in("spec_slug", shippedRows.map((s) => s.slug))
        .gte("run_at", cutoffIso)
        .limit(2000);
      const freshSet = new Set(((freshRuns ?? []) as Array<{ spec_slug: string }>).map((r) => r.spec_slug));
      if (shippedRows.some((s) => !freshSet.has(s.slug))) {
        return { pending: true, reason: "coverage past freshness window" };
      }
    }
  } catch (e) {
    // Fail-open: a coverage read hiccup should not stall the pass. Log-and-continue.
    console.warn(`[platformHasPendingWork] coverage read failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
  }

  // (9) unresolved evidence-backed regression fails — reconcileRegressionBacklog input.
  try {
    const { regressions } = await getHumanTestQueue(workspaceId);
    if (regressions.some((r) => (r.failing || []).some((f) => f && f.check_key))) {
      return { pending: true, reason: "unresolved regression fails" };
    }
  } catch (e) {
    console.warn(`[platformHasPendingWork] regression read failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
  }

  return { pending: false, reason: "idle" };
}

/**
 * True iff the cron wrote a gate beat with `produced.pending === true` for this workspace within the
 * last `PLATFORM_STANDING_PASS_IDLE_MS`. The cron reads this to keep the enqueue on every-5-min through
 * a transient quiet gap (one or two idle beats) and only back off to hourly across a solid idle span.
 * A missing / read-error result is treated as "recently active" so we never over-back-off on error.
 */
export async function platformStandingPassRecentlyActive(workspaceId: string): Promise<boolean> {
  const admin = createAdminClient();
  const cutoffIso = new Date(Date.now() - PLATFORM_STANDING_PASS_IDLE_MS).toISOString();
  try {
    const { data } = await admin
      .from("loop_heartbeats")
      .select("produced")
      .eq("loop_id", platformStandingPassGateLoopId(workspaceId))
      .gte("ran_at", cutoffIso)
      .order("ran_at", { ascending: false })
      .limit(20);
    return ((data ?? []) as Array<{ produced?: { pending?: boolean } | null }>)
      .some((r) => r.produced?.pending === true);
  } catch (e) {
    console.warn(`[platformStandingPassRecentlyActive] read failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
    return true; // fail-open: prefer running the pass over silencing it on a read error.
  }
}

/**
 * Write one gate beat to `loop_heartbeats` for this workspace's tick — the record the cron reads via
 * `platformStandingPassRecentlyActive` to decide whether we're in a solid idle span. Best-effort:
 * a failed write must never break the enqueue itself.
 */
export async function recordPlatformStandingPassGateBeat(
  workspaceId: string,
  pending: boolean,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const admin = createAdminClient();
  try {
    await admin.from("loop_heartbeats").insert({
      loop_id: platformStandingPassGateLoopId(workspaceId),
      kind: "cron" as const,
      ok: true,
      produced: { pending, reason, workspace_id: workspaceId, ...extra },
      detail: reason,
      ran_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[recordPlatformStandingPassGateBeat] write failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
  }
}
