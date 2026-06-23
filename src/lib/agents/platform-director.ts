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
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
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

  // Starting a NEW goal is never the director's call (only the CEO greenlights goals — devops-director
  // § leash). A zero-progress owned goal is unstarted: surface it to the CEO ONCE (deduped), never auto-start.
  for (const goal of mine.filter((g) => g.pct === 0)) {
    await escalateDiagnosisToCeo(admin, {
      workspaceId,
      specSlug: null,
      title: `Greenlight needed: ${goal.title}`,
      diagnosis: `The Platform goal "${goal.title}" is approved-but-unstarted (0%). Starting a new goal is a call only you can make, so I'm holding off — greenlight it and I'll escort it through its milestones.`,
      dedupeKey: `newgoal:${goal.slug}`,
      deepLink: `/dashboard/roadmap/goals/${goal.slug}`,
      escalationKind: "new_goal",
      metadata: { goal_slug: goal.slug, pct: goal.pct },
    });
  }

  const owned = mine.filter((g) => isApprovedInProgress(g));
  if (!owned.length) return { goals: [], queued: [], escalated: [] };

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

/** One escort spec's build state — what the escort reads to decide queue vs in-flight vs loop-guard. */
export interface SpecBuildState {
  /** an active (queued/building/…) or already-landed (completed/merged) build exists → leave it alone. */
  inFlight: boolean;
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
  let failedCount = 0;
  let lastError: string | null = null;
  for (const r of rows) {
    const status = String(r.status ?? "");
    if (FAILED_BUILD_STATUSES.has(status)) {
      failedCount++;
      if (lastError === null && r.error) lastError = String(r.error);
    } else {
      inFlight = true; // queued / building / needs_input / needs_approval / queued_resume / completed / merged
    }
  }
  return { inFlight, failedCount, lastError, total: rows.length };
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
 * an `escalated` director_activity row. DEDUPED on `dedupeKey` via the director_activity ledger (so it pings
 * the CEO once, even after a dismissed notification). Carries NO `agent_job_id` so the inbox reconciler —
 * which dismisses any request whose job left needs_approval — never reaps this standalone escalation.
 */
export async function escalateDiagnosisToCeo(
  admin: Admin,
  args: { workspaceId: string; specSlug: string | null; title: string; diagnosis: string; dedupeKey: string; deepLink: string; escalationKind: string; metadata?: Record<string, unknown> },
): Promise<{ emitted: boolean }> {
  // Dedup via the audit ledger — one escalation per dedupeKey, ever (survives a dismissed notification).
  const { data: prior } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("director_function", PLATFORM)
    .eq("action_kind", "escalated")
    .order("created_at", { ascending: false })
    .limit(500);
  const already = (prior ?? []).some((r) => (r.metadata as Record<string, unknown> | null)?.["dedupe_key"] === args.dedupeKey);
  if (already) return { emitted: false };

  const note = `🛠️ Ada (Platform/DevOps Director) escalated this to you:\n${args.diagnosis}`.slice(0, 4000);
  await admin.from("dashboard_notifications").insert({
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
  });
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
