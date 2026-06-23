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
