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
  inlineApproveActionId,
  buildApprovalContent,
  approvalDeepLink,
  type ApprovalJobRow,
} from "@/lib/agents/approval-inbox";
import { recordApprovalDecision } from "@/lib/agents/approval-decisions";
import { getOpenRepairs } from "@/lib/repair-agent";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import { getGoals, getRoadmap, getRoadmapFilters, getSpec, type GoalCard, type SpecCard, type SpecStatus } from "@/lib/brain-roadmap";
import { buildGate } from "@/lib/agents/director-directives";
import { recordDirectorActivity } from "@/lib/director-activity";
import { enqueueRepairJob, parseRepairSpecMeta } from "@/lib/repair-agent";
import { markSpecCardStatus } from "@/lib/spec-card-state";
import { buildControlTowerSnapshot, type LoopColor } from "@/lib/control-tower/monitor";
import { postDirectorMessage } from "@/lib/agents/director-board";
import { getPersona } from "@/lib/agents/personas";
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
 * Which director DRIVES a spec, given its OWNING function — the keystone routing for the auto-build lanes
 * (director-drives-all-specs-and-deferred-status Phase 2: "first live boss else up"). Reuses the approval-router
 * keystone: `resolveApprover` walks UP from the owner to the first live+autonomous ancestor (the owner ITSELF if
 * its director is live+autonomous), else falls through to the CEO. A spec whose own department-director is
 * live+autonomous is driven by that director; anything that falls through to the CEO is covered by the Platform
 * director — the keystone covering for not-yet-live departments. An owner-less spec defaults to Platform.
 *
 * Today only Platform is live, so Platform drives every non-deferred spec; as a Growth/CS/CMO director goes
 * live+autonomous, `resolveApprover` starts returning that owner and its specs rebalance OFF Platform — no re-spec.
 */
export function specDriver(owner: string | null | undefined, chart: OrgChartGraph, autonomy: AutonomyMap): string {
  const approver = resolveApprover(owner ?? PLATFORM, chart, autonomy);
  return approver === CEO ? PLATFORM : approver; // CEO fallthrough ⇒ the Platform keystone drives it
}

/** True iff the Platform director (this keystone) drives the spec owned by `owner` — its own, or any not-yet-live dept's. */
export function platformDrivesSpec(owner: string | null | undefined, chart: OrgChartGraph, autonomy: AutonomyMap): boolean {
  return specDriver(owner, chart, autonomy) === PLATFORM;
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
 */
function categoryFor(action: DirectorActionLike, bundle: DirectorActionLike[]): LeashCategory | null {
  const type = action.type;
  if (!type) return null;
  if (LEASH_ACTION_TYPES[type]) return LEASH_ACTION_TYPES[type];
  if (type === "run_prod_script" && bundle.some((a) => a.type === "apply_migration")) return "additive_backfill";
  return null;
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
  const targets = (jobs || []).filter((j) => routesToPlatform(String(j.kind), chart, autonomy));
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

/** Every distinct spec linked across a goal's milestones, resolved to its live SpecCard. */
function goalSpecs(goal: GoalCard, specBySlug: Map<string, SpecCard>): SpecCard[] {
  const slugs = new Set<string>();
  for (const m of goal.milestones) for (const s of m.specSlugs) slugs.add(s);
  return [...slugs].map((s) => specBySlug.get(s)).filter((c): c is SpecCard => !!c);
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

  // director-proposed-goals (Phase 1): the goal's lifecycle state — not `pct > 0` — now decides escortability.
  //   - `proposed` → awaits the CEO via its OWN Approval Request (the proposed-goal job). The escort does NOT
  //     touch it and does NOT re-escalate it: surfacing it is the proposed-goal flow's job, not the escort's.
  //   - `greenlit` at 0% → greenlit-but-unstarted, READY FOR DECOMPOSITION (Pia, Phase 2). The escort never
  //     auto-starts a goal, so it's left for the human-gated planner — no escalation, no auto-queue.
  //   - `greenlit` in-progress (0 < pct < 100) → escorted toward its milestones, exactly as before.
  // This replaces the old "every 0% owned goal escalates as a new-goal greenlight request": a proposed goal
  // is now an explicit, self-surfacing artifact and a greenlit 0% goal is genuinely approved-and-awaiting-Pia.

  const owned = mine.filter((g) => isApprovedInProgress(g));
  if (!owned.length) return { goals: [], queued: [], escalated: [] };

  // Build-gate (director-executable-plans-and-priority): if an active directive gates builds until a spec
  // ships, this lane queues NOTHING but the gate spec itself until then. Computed once per pass.
  const gate = await buildGate(admin, workspaceId, PLATFORM);

  const specBySlug = new Map(specs.map((s) => [s.slug, s]));
  const results: GoalEscortResult[] = [];
  const queuedAll: string[] = [];
  const escalatedAll: string[] = [];

  for (const goal of owned) {
    const queued: string[] = [];
    const inFlight: string[] = [];
    const escalated: string[] = [];
    for (const card of goalSpecs(goal, specBySlug)) {
      if (card.status === "shipped") continue; // already landed
      if (card.status === "deferred") continue; // parked — every auto-build lane skips a deferred spec until the CEO un-defers it (director-drives-all-specs-and-deferred-status Phase 1)
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
        // P6 — reflect the start on the live PM board instantly (the spec_card_state mirror), so the
        // board shows the director moving this spec without waiting on a markdown deploy. Best-effort.
        await markSpecCardStatus(workspaceId, card.slug, "in_progress", phaseStatesOf(card));
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
 * The gate is the **Repair-signature** (`SpecCard.repairSignature`) + **the keystone routing** — the Platform
 * director drives a fix spec whose owning department-director isn't live yet (director-drives-all-specs-and-
 * deferred-status Phase 2: owner-agnostic, "first live boss else up" via `platformDrivesSpec`). A repair-signed
 * fix builds straight through (the already-greenlit mandate) regardless of owner; once a department's director is
 * live+autonomous, its fix specs route to IT, not here. Same guards as the other escorts: dormant until
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
    if (card.status === "shipped") continue; // already landed
    if (card.status === "deferred") continue; // parked — a deferred fix spec is skipped until the CEO un-defers it (director-drives-all-specs-and-deferred-status Phase 1)
    if (gate && card.slug !== gate.gatedUntil && !card.critical) continue; // build-gate: pause routine, but let the gate spec + any **Priority:** critical (priority builds) through
    if (card.autoBuild === false) continue; // owner opted out of auto-build
    if (card.blockedBy.some((b) => !b.cleared)) continue; // still blocked → its auto-queue fires on unblock

    // The gap: an UNSTARTED (no ✅ phase) spec carrying a Repair-signature (an authored fix for a real bug)
    // that THIS director drives (its owning department-director isn't live yet — owner-agnostic keystone routing,
    // Phase 2). The box Repair agent now authors fix specs with a `## Phase 1 — close it ⏳` section, so gating on
    // `phases.length === 0` skipped them; gate on `counts.shipped === 0` instead so a fix spec with 0, 1, or N ⏳
    // phases (but nothing landed) is escorted, and the build chain carries its phases to completion. An unstarted
    // spec with NO repair signature is a new feature — the init lane handles it (with a soundness check), never here.
    const isFixSpec = card.counts.shipped === 0 && card.repairSignature && platformDrivesSpec(card.owner, chart, autonomy);
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
    // P6 — instant PM-companion mirror so the board shows the fix moving (its phase snapshot, if any).
    await markSpecCardStatus(workspaceId, card.slug, "in_progress", phaseStatesOf(card));
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: PLATFORM,
      actionKind: "escorted_fix",
      specSlug: card.slug,
      reason: `Escorting authored fix spec: queued ${card.slug}${retry ? ` (re-attempt #${state.failedCount + 1})` : ""} — building the bug fix.`,
      metadata: { spec_slug: card.slug, kind: "fix", retry, autonomous: true },
    });
  }

  return { fixQueued, escalated };
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
export async function escalateApprovalRequestToCeo(
  admin: Admin,
  target: DirectorTargetJob,
  diagnosis: string,
): Promise<{ ok: boolean; created: boolean }> {
  const note = `🛠️ Ada (Platform/DevOps Director) escalated this to you — outside the leash / a call only you should make:\n${diagnosis}`.slice(0, 4000);
  const { data: notifs } = await admin
    .from("dashboard_notifications")
    .select("id, body, metadata")
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("dismissed", false)
    .limit(2000);
  const existing = (notifs ?? []).find((n) => (n.metadata as Record<string, unknown> | null)?.["agent_job_id"] === target.id);

  if (existing) {
    const meta = { ...((existing.metadata as Record<string, unknown> | null) ?? {}), routed_to_function: CEO, escalated_by_director: PLATFORM, escalation_reason: diagnosis.slice(0, 2000) };
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
    escalated_by_director: PLATFORM,
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

/** Cap how many NEW reconcile ACTIONS (repair enqueues + stuck-fix escalations) one pass takes. */
export const PLATFORM_DIRECTOR_RECONCILE_CAP = 8;

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
  const empty: ErrorBacklogReconcileResult = { enqueued: [], escalated: [], confirmed: 0, scanned: 0 };
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

  const enqueued: string[] = [];
  const escalated: string[] = [];
  let confirmed = 0;

  // Dedup repeated signatures within this same pass (an error + its sibling loop alert can collide); the cap
  // bounds NEW actions (enqueues + escalations) — idle confirms are cheap and always counted.
  const handled = new Set<string>();
  for (const item of items) {
    if (handled.has(item.signature)) continue;
    handled.add(item.signature);
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

  return { enqueued, escalated, confirmed, scanned: handled.size };
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
  /** Rafa's no-fix calls reviewed today (dismissed + kept + escalated-from-review) — Phase 2 rollup. */
  reviewedRepairs: number;
  /** of those reviews, how many Ada cleared (dismissed_repair rows). */
  dismissedRepairs: number;
  /** of those reviews, how many she escalated back to the CEO (escalated rows, repair_dismissal_suspect). */
  escalatedRepairs: number;
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

/** Ada's conversational watch post (plain text, no markdown) — health + what she did today. */
export function composePlatformWatchBody(health: PlatformHealth, activity: PlatformWatchActivity): string {
  const persona = getPersona(PLATFORM);
  const repairLine = platformRepairReviewLine(activity);
  return `${persona.emoji} Platform watch — ${platformHealthLine(health)}. Today: ${platformActivityLine(activity)}.${repairLine ? ` ${repairLine}` : ""}`;
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
  const activity: PlatformWatchActivity = { squashed: 0, escorting: 0, escalated: 0, reviewedRepairs: 0, dismissedRepairs: 0, escalatedRepairs: 0 };
  for (const r of (activityRows ?? []) as { action_kind: string; metadata: Record<string, unknown> | null }[]) {
    const repairEscalation = r.action_kind === "escalated" && r.metadata?.["escalation_kind"] === "repair_dismissal_suspect";
    if (r.action_kind === "approved_approval") activity.squashed++;
    else if (r.action_kind === "escorted_goal") activity.escorting++;
    else if (r.action_kind === "escalated") activity.escalated++;
    // Phase 2 rollup — each review of one of Rafa's no-fix calls (a dismiss, a keep, or an escalate-back).
    if (r.action_kind === "dismissed_repair") {
      activity.dismissedRepairs++;
      activity.reviewedRepairs++;
    } else if (r.action_kind === "kept_repair") {
      activity.reviewedRepairs++;
    } else if (repairEscalation) {
      activity.escalatedRepairs++;
      activity.reviewedRepairs++;
    }
  }

  // Don't spam a fully-quiet, all-green day — post only when there's health to flag or work to report.
  const hasActivity = activity.squashed > 0 || activity.escorting > 0 || activity.escalated > 0 || activity.reviewedRepairs > 0;
  if (!hasActivity && health.color === "green") return { posted: false, reason: "quiet" };

  await postDirectorMessage({
    workspaceId,
    author: "director",
    authorFunction: PLATFORM,
    body: composePlatformWatchBody(health, activity),
    kind: "update",
    metadata: { source: "platform-watch", watch_date: date, health, activity },
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

/** Cap how many partially-shipped specs one grooming pass investigates (bound the per-pass cost). */
export const PLATFORM_DIRECTOR_GROOM_CAP = 4;

/** A partially-shipped spec the director may groom: ≥1 ✅ phase, ≥1 ⏳ phase, none 🚧, no active build. */
export interface GroomCandidate {
  slug: string;
  title: string;
  owner?: string;
  parent?: string;
  shippedPhases: string[]; // titles of the ✅ phases (context for the investigation)
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
 * Has this spec ALREADY had a terminal groom decision (split into cards, or escalated as unsure)? A split
 * commits the new card(s) + the folded parent to `main`, which the box's bundled `fs` copy won't reflect
 * until its next self-update — so without this ledger dedup the same candidate would re-split every pass.
 * (A `continue` is NOT deduped here: its queued build flips the spec in-flight, which the candidate filter
 * already excludes, and a later FAILED build should be re-groomed under the loop-guard.) Best-effort.
 */
export async function alreadyGroomed(admin: Admin, slug: string): Promise<boolean> {
  const { data } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("director_function", PLATFORM)
    .in("action_kind", ["groomed_split", "escalated"])
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

  const { specs } = await getRoadmap();
  const partial = specs.filter(
    (s) =>
      s.status !== "shipped" &&
      s.status !== "deferred" && // parked — grooming skips a deferred spec (director-drives-all-specs-and-deferred-status Phase 1)
      s.counts.shipped >= 1 && // at least one phase has landed
      s.counts.planned >= 1 && // at least one ⏳ phase remains
      s.counts.in_progress === 0 && // no 🚧 phase (a phase actively building) — that's an active build
      s.autoBuild !== false, // owner opted out of auto-build → leave it under manual control (mirrors the escort)
  );

  const out: GroomCandidate[] = [];
  for (const s of partial) {
    if (out.length >= PLATFORM_DIRECTOR_GROOM_CAP) break;
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
      shippedPhases: s.phases.filter((p) => p.status === "shipped").map((p) => p.title),
      remainingPhases: s.phases.filter((p) => p.status === "planned").map((p) => p.title),
      raw: got.raw,
      failedBuilds: state.failedCount,
      lastError: state.lastError,
    });
  }
  return out;
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
    "",
    `Spec: ${c.slug} — ${c.title}`,
    `Owner: ${c.owner ?? "—"} · Parent: ${c.parent ?? "—"}`,
    `Shipped phases (✅): ${c.shippedPhases.join(" · ") || "—"}`,
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
    "- New card markdown MUST contain: an H1 title ending with ⏳; the SAME **Owner:** and **Parent:** lines as",
    "  the parent; a line `**Deferred:** split from [[" + c.slug + "]] — not needed now: <reason>`; and the",
    "  phase's content + any verification, as a `## Phase 1 — <name> ⏳` section (re-number to start at 1).",
    "- Rewritten parent: REMOVE the split `## Phase` section(s); keep the H1 and EVERY remaining phase ✅; keep",
    "  whatever Verification still applies. After your edit the parent must have NO ⏳ and NO 🚧 left (it folds).",
    "",
    "Final message = ONLY one JSON object (no markdown):",
    '{"verdict":"continue","reasoning":"<why the next ⏳ phase is needed now>"}',
    '{"verdict":"split","reasoning":"<why the leftovers are future, not needed now>","splits":[{"phase_title":"<the ⏳ phase>","slug":"' + c.slug + '-<phase>","markdown":"<full new card markdown>","reason":"<not-needed-now reason>"}],"parent_markdown":"<full rewritten parent markdown, every phase ✅>"}',
    '{"verdict":"escalate","reasoning":"<why this is genuinely ambiguous / possibly load-bearing — needs the CEO>"}',
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

/** The parsed grooming verdict (the box lane's `claude -p` JSON). */
export interface GroomVerdict {
  verdict?: string;
  reasoning?: string;
  splits?: GroomSplit[];
  parent_markdown?: string;
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
// Owner-agnostic drive (director-drives-all-specs-and-deferred-status Phase 2): the lane no longer gates on
// `owner === platform`. ANY unblocked, non-deferred, unstarted spec is a candidate, ROUTED via the keystone —
// `platformDrivesSpec` ("first live boss else up"): a department whose own director is live+autonomous keeps its
// specs (they route to IT); everything else flows up to the Platform director, who covers for the not-yet-live
// departments. Today only Platform is live, so it drives every non-deferred unstarted spec.
//
// Hard rails (unchanged): a spec that is part of an unstarted (0%) GOAL is NOT touched here — escortApprovedGoals
// already surfaces a zero-progress owned goal to the CEO as a new-goal call; a deferred spec is skipped (Phase 1);
// destructive/irreversible/multi-choice still escalate (the investigation's job). Dormant until live+autonomous.

/** Cap how many unstarted non-fix specs one initiation pass investigates (bound the per-pass cost). */
export const PLATFORM_DIRECTOR_INIT_CAP = 4;

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

/**
 * Has this spec ALREADY had a TERMINAL init escalation (ambiguous soundness, or a loop-guard "deeper issue")?
 * After such an escalation the spec is still unstarted + unblocked, so without this ledger dedup it would be
 * re-investigated (a wasted `claude -p`) and re-escalated every pass. A successful INITIATE doesn't need this —
 * its queued build flips the spec in-flight, which findInitCandidates already excludes. Best-effort.
 */
export async function alreadyInitiated(admin: Admin, slug: string): Promise<boolean> {
  const { data } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("director_function", PLATFORM)
    .eq("action_kind", "escalated")
    .order("created_at", { ascending: false })
    .limit(1000);
  const keys = new Set(initEscalationKeys(slug));
  return (data ?? []).some((r) => keys.has(String((r.metadata as Record<string, unknown> | null)?.["dedupe_key"] ?? "")));
}

/**
 * Find the unblocked, UNSTARTED (0 ✅) specs the director DRIVES and may initiate this pass — the gap no
 * other lane covers: NOT Repair-signed (escortFixSpecs owns those), NOT goal-linked (the goal-walk / new-goal
 * escalation owns those), not opted out (`**Auto-build:** off`), no in-flight build, and not already
 * terminally escalated by this lane. Owner-agnostic (Phase 2): any owner's spec qualifies, routed via the
 * keystone `platformDrivesSpec` — Platform drives a spec whose owning department-director isn't live+autonomous,
 * else that director drives it (the spec is filtered out here). A NO-OP until Platform is live+autonomous (like
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
  const unstarted = specs.filter(
    (s) =>
      s.status !== "shipped" &&
      s.status !== "deferred" && // parked — the initiation lane never starts a deferred spec (director-drives-all-specs-and-deferred-status Phase 1)
      s.counts.shipped === 0 && // unstarted — no phase has landed
      s.autoBuild !== false && // owner opted out of auto-build → leave it under manual control
      !s.repairSignature && // a fix spec — escortFixSpecs owns it, never the feature-init lane
      platformDrivesSpec(s.owner, chart, autonomy) && // owner-agnostic, keystone-routed: this director drives it ("first live boss else up")
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

  const out: InitCandidate[] = [];
  for (const s of candidates) {
    if (out.length >= PLATFORM_DIRECTOR_INIT_CAP) break;
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
    "Final message = ONLY one JSON object (no markdown):",
    '{"verdict":"initiate","reasoning":"<why the spec is sound, in-scope, and safe to build now>"}',
    '{"verdict":"escalate","reasoning":"<why this needs the CEO — ambiguous / out of scope / a new goal / destructive / a choice>"}',
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
}

/**
 * Has the director ALREADY reviewed THIS repair job? Keyed on the job id (carried in every review row's
 * metadata.repair_job_id) so "reviewed once" holds for the SAME item — a `dismiss` completes the job (it
 * leaves getOpenRepairs), but a `keep`/`escalate` leaves it `needs_attention`, so without this dedup it would
 * be re-investigated every pass. A re-fire is a NEW job (new id) → a fresh review, exactly as the spec wants.
 * Matches the three review action_kinds (`dismissed_repair` / `kept_repair` / `escalated`). Best-effort.
 */
export async function alreadyReviewedDismissal(admin: Admin, jobId: string): Promise<boolean> {
  const { data } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("director_function", PLATFORM)
    .in("action_kind", ["dismissed_repair", "kept_repair", "escalated"])
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
    "Final message = ONLY one JSON object (no markdown):",
    '{"verdict":"dismiss","reasoning":"<your INDEPENDENT confirmation it is genuinely transient/foreign-noise/benign and not a masked real bug>"}',
    '{"verdict":"escalate","reasoning":"<your contrary diagnosis — why this looks like a real bug in OUR code Rafa mislabeled benign>"}',
    '{"verdict":"external","reasoning":"<your verified diagnosis that the root cause is an external dependency break, not OUR code>","alternatives":["wait/retry …","swap provider …","degrade gracefully …"]}',
    '{"verdict":"keep","reasoning":"<why this is a genuine needs-human call you can neither confirm benign, call a real bug, nor confirm external>"}',
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

  // Resolve the originating error_events row (the repair job's spec_slug IS the error signature, e.g. "vercel:…").
  if (job.spec_slug) {
    await admin.from("error_events").update({ status: "resolved" }).eq("signature", job.spec_slug).eq("status", "open");
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
