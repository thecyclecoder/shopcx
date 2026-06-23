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
 * no-op — the machinery is built but dormant. Escalation ROUTING to the CEO inbox is Phase 3; in
 * Phase 1 a non-leash / unconfirmable request is simply left untouched (it stays needs_approval) and
 * logged as escalated, never auto-approved.
 *
 * Phase 2 (escortApprovedGoals, at the bottom) adds the other half of the leash — milestone progression
 * of an ALREADY-APPROVED goal: a proactive sweep that drives the unblocked specs of the goals the
 * director owns through the EXISTING build chain (auto-queue + builder chain + auto-ship + fold), logging
 * each advance. Also dormant until live+autonomous; starting a NEW goal is never auto (Phase 3 escalation).
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
import { ownerFunctionForKind, inlineApproveActionId, type ApprovalJobRow } from "@/lib/agents/approval-inbox";
import { recordApprovalDecision } from "@/lib/agents/approval-decisions";
import { getGoals, getRoadmap, type GoalCard, type SpecCard } from "@/lib/brain-roadmap";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** The Platform/DevOps director's function slug — the DRI this director embodies. */
export const PLATFORM = "platform";

// ── The leash (the goals/devops-director § leash + operational-rules autonomy rule) ──────────────
// What the director MAY auto-approve. A structural gate (which action class) plus — enforced by the
// runner's read-only investigation — a soundness gate ("never rubber-stamps"). Anything outside this,
// and anything destructive/irreversible/goal-touching, ALWAYS escalates to the CEO.
export type LeashCategory = "error_fix" | "db_health" | "additive_migration" | "monitoring_fix";

export const LEASH_CATEGORIES: LeashCategory[] = ["error_fix", "db_health", "additive_migration", "monitoring_fix"];

/**
 * The pending-action types that are EVER leash candidates → their leash category. The action must
 * still be a single, plain inline-approve (inlineApproveActionId) AND pass the investigation verdict.
 * Multi-choice actions (coverage_register register-vs-exempt, hero preview) are never auto-decided in
 * Phase 1 — they fall through to the CEO. Milestone progression (escorting goals) is Phase 2.
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
 * The single, plain-approve action of a LEASH type the director may consider, or null. Reuses the
 * canonical inline-approve gate (inlineApproveActionId — single pending action, not multi-choice) and
 * adds the leash-type filter. Null ⇒ outside the auto-approve envelope ⇒ escalate, never approve.
 */
export function directorLeashCandidate(job: DirectorTargetJob): { actionId: string; category: LeashCategory } | null {
  const actionId = inlineApproveActionId(job as unknown as ApprovalJobRow);
  if (!actionId) return null;
  const action = (job.pending_actions || []).find((a) => a.id === actionId);
  const category = action?.type ? LEASH_ACTION_TYPES[action.type] : undefined;
  if (!category) return null;
  return { actionId, category };
}

/** The read-only brief the director investigates — the cause + proposed fix, inline. */
export interface DirectorBrief {
  jobId: string;
  kind: string;
  specSlug: string | null;
  category: LeashCategory;
  summary: string;
  preview: string;
  cmd: string;
  logTail: string;
}

export function buildDirectorBrief(job: DirectorTargetJob, candidate: { actionId: string; category: LeashCategory }): DirectorBrief {
  const action = (job.pending_actions || []).find((a) => a.id === candidate.actionId) ?? {};
  return {
    jobId: job.id,
    kind: job.kind,
    specSlug: job.spec_slug,
    category: candidate.category,
    summary: action.summary || "",
    preview: action.preview || "",
    cmd: action.cmd || "",
    logTail: (job.log_tail || "").slice(-2000),
  };
}

/** The Max `claude -p` investigation prompt — read-only diagnose → one JSON verdict. */
export function directorInvestigationPrompt(brief: DirectorBrief): string {
  return [
    "You are Ada — the Platform/DevOps Director for ShopCX, running on Max (read-only prod DB + the brain, no API key).",
    "A platform tool you supervise raised an Approval Request that routed to YOU (Platform is live + autonomous).",
    "Your job: investigate the cause + the proposed fix READ-ONLY, then decide — AUTO-APPROVE only if it is",
    "SOUND, LOW-RISK, and WITHIN THE LEASH; otherwise ESCALATE to the CEO. NEVER rubber-stamp: if you cannot",
    "confirm it is sound and in-leash, escalate.",
    "",
    "The leash — you MAY auto-approve ONLY these classes:",
    "- error_fix: a repair-agent fix for a real bug — the authored fix spec is sound + scoped.",
    "- db_health: a DB index / health fix — no destructive DDL.",
    "- additive_migration: an ADDITIVE, REVERSIBLE migration (new table/column/index) — NO DROP/DELETE/destructive ALTER/data loss.",
    "- monitoring_fix: a platform-monitoring registry fix.",
    "ALWAYS ESCALATE (never auto-approve): anything destructive or irreversible (DROP/DELETE/data-dropping),",
    "modifying or abandoning an approved goal, starting a NEW goal, or anything you cannot confirm is sound.",
    "",
    `This request — category=${brief.category}, kind=${brief.kind}, spec=${brief.specSlug ?? "—"}:`,
    `summary: ${brief.summary}`,
    brief.preview ? `proposed fix / preview:\n${brief.preview}` : "",
    brief.cmd ? `command that runs on approval: ${brief.cmd}` : "",
    brief.logTail ? `investigation log so far:\n${brief.logTail}` : "",
    "",
    "Investigate read-only (the implicated spec / the migration SQL / the diagnosed code). Confirm the fix is",
    "sound and within the leash before approving.",
    "Final message = ONLY one JSON object:",
    '{"verdict":"auto-approve","leash_category":"error_fix|db_health|additive_migration|monitoring_fix","reasoning":"<why it is sound + low-risk + within the leash>"}',
    '{"verdict":"escalate","reasoning":"<why this needs the CEO — high-stakes / irreversible / unconfirmable / out of leash>"}',
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
  actionId: string,
  reasoning: string,
): Promise<{ ok: boolean; error?: string }> {
  const actions = (target.pending_actions || []).map((a) => (a.id === actionId ? { ...a, status: "approved" } : a));
  const stillPending = actions.some((a) => (a.status ?? "pending") === "pending");
  const patch: Record<string, unknown> = { pending_actions: actions, updated_at: new Date().toISOString() };
  if (!stillPending) patch.status = "queued_resume";
  const { error } = await admin.from("agent_jobs").update(patch).eq("id", target.id);
  if (error) return { ok: false, error: error.message };

  await recordApprovalDecision(admin, {
    workspaceId: target.workspace_id,
    agentJobId: target.id,
    pendingActionId: actionId,
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
 * An already-approved goal the director MAY escort (the leash): one with real progress (`pct > 0` — work
 * the CEO already greenlit) that isn't yet complete. A ZERO-progress goal is "not yet started"; kicking off
 * its first spec would be STARTING a new goal, which always escalates to the CEO (Phase 3) — never the
 * director. (No goal-approval flag exists in the DB; progress is the proxy for "already greenlit".)
 */
function isApprovedInProgress(goal: GoalCard): boolean {
  return goal.pct > 0 && goal.pct < 100;
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
export async function escortApprovedGoals(admin: Admin): Promise<{ goals: GoalEscortResult[]; queued: string[] }> {
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return { goals: [], queued: [] }; // dormant until Phase 4 flips the flag

  const workspaceId = await resolveDirectorWorkspace(admin);
  if (!workspaceId) return { goals: [], queued: [] };

  const [goals, { specs }] = await Promise.all([getGoals(), getRoadmap()]);
  const owned = goals.filter((g) => g.owner === PLATFORM && isApprovedInProgress(g));
  if (!owned.length) return { goals: [], queued: [] };

  const specBySlug = new Map(specs.map((s) => [s.slug, s]));
  const results: GoalEscortResult[] = [];
  const queuedAll: string[] = [];

  for (const goal of owned) {
    const queued: string[] = [];
    const inFlight: string[] = [];
    for (const card of goalSpecs(goal, specBySlug)) {
      if (card.status === "shipped") continue; // already landed
      if (card.autoBuild === false) continue; // owner opted this spec out of auto-build (mirrors autoQueueUnblockedBy)
      if (card.blockedBy.some((b) => !b.cleared)) continue; // still blocked → the auto-queue fires when its last blocker ships

      // Already has a build job (any status)? → the auto-queue / chain / a manual build is handling it.
      // Confirm it's moving (the escort's "did each land clean" check), don't stack a duplicate.
      const { data: existing } = await admin
        .from("agent_jobs")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("spec_slug", card.slug)
        .eq("kind", "build")
        .limit(1);
      if (existing && existing.length) {
        inFlight.push(card.slug);
        continue;
      }

      // The gap: an unblocked, unshipped, never-queued spec of an approved goal. Kick off its build — the
      // existing chain + auto-ship + fold + blocked_by auto-queue carry it from here (we don't rebuild them).
      const { error } = await admin.from("agent_jobs").insert({
        workspace_id: workspaceId,
        spec_slug: card.slug,
        kind: "build",
        status: "queued",
        created_by: null,
        instructions: `Escorted by the Platform/DevOps Director: ${goal.title} (${goal.pct}%) — ${card.slug} is unblocked; sequencing its build toward the next milestone.`,
      });
      if (!error) {
        queued.push(card.slug);
        queuedAll.push(card.slug);
      }
    }

    if (queued.length || inFlight.length) {
      results.push({ goalSlug: goal.slug, goalTitle: goal.title, pct: goal.pct, queued, inFlight });
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
        metadata: { goal_slug: goal.slug, pct: goal.pct, queued, in_flight: inFlight, autonomous: true },
      });
    }
  }

  return { goals: results, queued: queuedAll };
}
