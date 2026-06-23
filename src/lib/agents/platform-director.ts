/**
 * platform-director — the queue plumbing + autonomy policy behind the **Platform/DevOps Director box
 * worker** ([[docs/brain/specs/platform-director-agent.md]]), the FIRST live director of the
 * [[docs/brain/goals/devops-director.md]] goal. It takes the CEO out of platform operations: it
 * **investigates → auto-approves** its routed inbox (within the leash), **escorts approved goals
 * through their milestones**, **loop-guards** repeated failures, and **reports up in human terms** —
 * escalating only the genuinely high-stakes calls.
 *
 * North star (operational-rules § supervisable autonomy): the director is the objective-owner above the
 * mature platform tools ([[repair-agent|repair]], [[db-health-agent]], [[coverage-register-agent]], the
 * builder chain, control-tower). It **orchestrates, it does not rebuild** — it leans on the existing
 * [[agent-jobs]] approve path + the `blocked_by` auto-queue ([[agent-jobs]] `autoQueueUnblockedBy`)
 * rather than reimplementing them. Every decision is logged to [[approval-decisions]] +
 * [[director-activity]] so the CEO can audit what the proxy decided and why (CEO → Director → tool).
 *
 * Activation is the [[approval-router|`live + autonomous`]] flag on the `platform` function (owner-
 * confirmed, off by default): the director lane only fires when platform is an auto-approver, and the
 * routing engine then sends platform approvals to it instead of the CEO. Fail-safe to the bone — an
 * unconfirmable request, or any high-stakes call, ESCALATES; it never auto-approves on uncertainty.
 *
 * This file is the pure policy + the DB read/act helpers; the box runner (`runPlatformDirectorJob` in
 * scripts/builder-worker.ts) orchestrates the Max `claude -p` investigation between them.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import { isAutoApprover, loadAutonomyMap, CEO } from "@/lib/agents/approval-router";
import { ownerFunctionForKind } from "@/lib/agents/approval-inbox";
import { recordApprovalDecision } from "@/lib/agents/approval-decisions";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** The function this director IS (the platform/DevOps seat — 🛠️ Ada). */
export const PLATFORM_DIRECTOR_FUNCTION = "platform";

/** The sentinel spec_slug a platform-director TICK job carries (it has no single spec). */
export const PLATFORM_DIRECTOR_SLUG = "platform-director-tick";

/** Loop-guard: a build that fails this many times → STOP resubmitting, escalate a diagnosis to CEO. */
export const PLATFORM_LOOP_GUARD_MAX = 2;

/** The window over which the loop-guard counts failed build attempts + escort/escalation dedup. */
export const PLATFORM_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** With no routed approvals, still wake on this cadence so escort + the board report keep flowing. */
export const PLATFORM_ESCORT_CADENCE_MS = 30 * 60 * 1000; // 30 min

/** Statuses that mean a platform-director tick is still "live" (working) — dedup to one in-flight. */
const LIVE_DIRECTOR_STATUSES = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "needs_attention"];

/**
 * Destructive / irreversible SQL or infra ops — the HARD leash. These ALWAYS escalate to the CEO, no
 * matter what the investigation concludes (belt-and-suspenders over the LLM judgment). Additive DDL
 * (CREATE / ADD COLUMN / CREATE INDEX) is reversible and stays inside the leash.
 */
const DESTRUCTIVE_RE = /\b(drop\s+(table|column|database|schema|index|type|constraint|policy)|truncate\b|delete\s+from|drop\s+not\s+null|alter\s+column\s+\w+\s+type|delete\s+infra|destroy|tear\s*down)\b/i;

/** The leash class the code assigns before the LLM weighs in. */
export type LeashClass = "auto-eligible" | "escalate" | "judge";

/** One Platform-routed Approval Request the director must decide (notification joined to its job). */
export interface RoutedApproval {
  notificationId: string;
  jobId: string;
  kind: string;
  specSlug: string | null;
  raisedByFunction: string;
  title: string;
  /** the cause + proposed fix INLINE (the inbox body) — what the director reads to confirm soundness. */
  body: string;
  /** the still-pending actions on the job (what an approve would execute). */
  pendingActions: { id: string; type?: string; summary?: string; cmd?: string; preview?: string; status?: string }[];
  logTail: string;
}

/** Does any part of this approval describe a destructive / irreversible action? (hard escalate). */
export function isDestructiveApproval(a: RoutedApproval): boolean {
  const haystack = [a.title, a.body, a.logTail, ...a.pendingActions.flatMap((p) => [p.summary, p.cmd, p.preview])]
    .filter(Boolean)
    .join("\n");
  return DESTRUCTIVE_RE.test(haystack);
}

/**
 * The deterministic pre-classification the director applies BEFORE investigating. Destructive ⇒ hard
 * escalate. The mature, mechanical platform classes (repair fixes, db-health, coverage-monitoring) are
 * auto-ELIGIBLE (the investigation still confirms soundness — eligible is not approved). Everything
 * else ⇒ judge (the LLM decides approve-within-leash vs escalate). Pure.
 */
export function leashClass(a: RoutedApproval): LeashClass {
  if (isDestructiveApproval(a)) return "escalate";
  // The mature platform tools the director supervises — error fixes, db indexes/health, monitoring fixes.
  if (a.kind === "repair" || a.kind === "db_health" || a.kind === "coverage-register" || a.kind === "regression") {
    return "auto-eligible";
  }
  // Starting NEW work (a goal decomposition) is the CEO's call, never the director's.
  if (a.kind === "plan") return "escalate";
  return "judge";
}

/** Resolve the workspace a director tick lands under — ride the latest agent_jobs row, else the first ws. */
export async function resolveDirectorWorkspace(admin: Admin): Promise<string | null> {
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
 * Load the open Platform-routed Approval Requests for a workspace (the director's inbox). Joins each
 * undismissed `agent_approval_request` notification routed to `platform` to its still-`needs_approval`
 * agent_jobs row — a job that has already left needs_approval (decided elsewhere) is skipped.
 */
export async function getRoutedPlatformApprovals(admin: Admin, workspaceId: string): Promise<RoutedApproval[]> {
  const { data: notifs } = await admin
    .from("dashboard_notifications")
    .select("id, title, body, metadata")
    .eq("workspace_id", workspaceId)
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("dismissed", false)
    .limit(200);
  const rows = (notifs ?? []) as { id: string; title: string | null; body: string | null; metadata: Record<string, unknown> | null }[];

  const routed = rows.filter((n) => (n.metadata?.["routed_to_function"] ?? CEO) === PLATFORM_DIRECTOR_FUNCTION);
  if (routed.length === 0) return [];

  const out: RoutedApproval[] = [];
  for (const n of routed) {
    const jobId = typeof n.metadata?.["agent_job_id"] === "string" ? (n.metadata!["agent_job_id"] as string) : null;
    if (!jobId) continue;
    const { data: jobRow } = await admin
      .from("agent_jobs")
      .select("id, kind, spec_slug, status, pending_actions, log_tail")
      .eq("id", jobId)
      .maybeSingle();
    const job = jobRow as { id: string; kind: string; spec_slug: string | null; status: string; pending_actions: unknown; log_tail: string | null } | null;
    if (!job || job.status !== "needs_approval") continue; // decided elsewhere / gone — skip
    const pending = (Array.isArray(job.pending_actions) ? job.pending_actions : []) as RoutedApproval["pendingActions"];
    out.push({
      notificationId: n.id,
      jobId: job.id,
      kind: job.kind,
      specSlug: job.spec_slug,
      raisedByFunction: ownerFunctionForKind(job.kind) ?? CEO,
      title: n.title ?? "",
      body: n.body ?? job.log_tail ?? "",
      pendingActions: pending.filter((p) => (p.status ?? "pending") === "pending"),
      logTail: job.log_tail ?? "",
    });
  }
  return out;
}

/**
 * Loop-guard ledger: how many build attempts for THIS spec FAILED within the window. At
 * `PLATFORM_LOOP_GUARD_MAX` the director stops resubmitting and escalates a "likely deeper issue"
 * diagnosis to the CEO — never a blind resubmit loop.
 */
export async function buildFailureCount(admin: Admin, specSlug: string): Promise<number> {
  const sinceIso = new Date(Date.now() - PLATFORM_RECENT_WINDOW_MS).toISOString();
  const { count } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("kind", "build")
    .eq("spec_slug", specSlug)
    .eq("status", "failed")
    .gte("created_at", sinceIso);
  return count ?? 0;
}

/** Has the director already escalated this slug recently? (escalation dedup — one per window). */
export async function alreadyEscalated(admin: Admin, workspaceId: string, specSlug: string): Promise<boolean> {
  const sinceIso = new Date(Date.now() - PLATFORM_RECENT_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("director_activity")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("director_function", PLATFORM_DIRECTOR_FUNCTION)
    .eq("action_kind", "escalated")
    .eq("spec_slug", specSlug)
    .gte("created_at", sinceIso)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Enqueue ONE platform-director tick. Best-effort + idempotent. No-op unless the `platform` function is
 * live + autonomous (the activation switch — off by default, so the director is dormant until the owner
 * confirms it). Deduped to a single in-flight tick. Otherwise enqueued when there is routed work, or on
 * the escort cadence (so goal-escort + the board report keep flowing even with an empty inbox). Returns
 * whether a tick was enqueued. NEVER throws — it rides the box poll loop.
 */
export async function enqueuePlatformDirectorTick(admin: Admin): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    const autonomy = await loadAutonomyMap();
    if (!isAutoApprover(PLATFORM_DIRECTOR_FUNCTION, autonomy)) {
      return { enqueued: false, reason: "platform not live+autonomous (dormant)" };
    }

    // Dedup — one live tick at a time.
    const { data: live } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("kind", "platform-director")
      .in("status", LIVE_DIRECTOR_STATUSES)
      .limit(1)
      .maybeSingle();
    if (live) return { enqueued: false, reason: "live platform-director tick exists" };

    const workspaceId = await resolveDirectorWorkspace(admin);
    if (!workspaceId) return { enqueued: false, reason: "no workspace to attach the tick to" };

    // Work-or-cadence gate: routed approvals waiting OR it's been a while since the last tick.
    const routed = await getRoutedPlatformApprovals(admin, workspaceId);
    let due = routed.length > 0;
    if (!due) {
      const { data: last } = await admin
        .from("agent_jobs")
        .select("created_at")
        .eq("kind", "platform-director")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastAt = (last as { created_at?: string } | null)?.created_at;
      due = !lastAt || Date.now() - Date.parse(lastAt) > PLATFORM_ESCORT_CADENCE_MS;
    }
    if (!due) return { enqueued: false, reason: "no routed work + within escort cadence" };

    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: PLATFORM_DIRECTOR_SLUG,
      kind: "platform-director",
      status: "queued",
      instructions: JSON.stringify({ routed_count: routed.length }),
    });
    if (error) {
      console.warn("[platform-director] enqueue tick failed:", error.message);
      return { enqueued: false, reason: error.message };
    }
    return { enqueued: true, reason: routed.length ? `${routed.length} routed approval(s)` : "escort cadence" };
  } catch (err) {
    console.warn("[platform-director] enqueuePlatformDirectorTick threw:", err instanceof Error ? err.message : err);
    return { enqueued: false, reason: "threw" };
  }
}

/**
 * APPROVE a routed approval — the existing approve path (mirror of approveRoadmapAction, minus the owner
 * gate the director doesn't pass): mark every pending action approved + flip the job `queued_resume` so
 * the worker executes it. Logs the autonomous decision to [[approval-decisions]] + [[director-activity]].
 * Never rubber-stamps: callers only reach here after confirming the approval is sound + within the leash.
 */
export async function directorApproveApproval(
  admin: Admin,
  args: { workspaceId: string; approval: RoutedApproval; reasoning: string },
): Promise<{ ok: boolean }> {
  const { workspaceId, approval, reasoning } = args;
  // Re-read the live job so we never clobber a concurrent decision.
  const { data: jobRow } = await admin.from("agent_jobs").select("status, pending_actions").eq("id", approval.jobId).maybeSingle();
  const job = jobRow as { status: string; pending_actions: unknown } | null;
  if (!job || job.status !== "needs_approval") return { ok: false };
  const actions = (Array.isArray(job.pending_actions) ? job.pending_actions : []) as Array<Record<string, unknown>>;
  const next = actions.map((a) => ((a.status ?? "pending") === "pending" ? { ...a, status: "approved" } : a));
  const stillPending = next.some((a) => (a.status ?? "pending") === "pending");
  await admin
    .from("agent_jobs")
    .update({ pending_actions: next, status: stillPending ? "needs_approval" : "queued_resume", updated_at: new Date().toISOString() })
    .eq("id", approval.jobId);

  await recordApprovalDecision(admin, {
    workspaceId,
    agentJobId: approval.jobId,
    pendingActionId: approval.pendingActions[0]?.id ?? null,
    raisedByFunction: approval.raisedByFunction,
    routedToFunction: PLATFORM_DIRECTOR_FUNCTION,
    decidedBy: "director",
    decision: "approved",
    reasoning,
    autonomous: true,
    metadata: { kind: approval.kind, spec_slug: approval.specSlug, leash: leashClass(approval) },
  });
  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: PLATFORM_DIRECTOR_FUNCTION,
    actionKind: "approved_request",
    specSlug: approval.specSlug,
    reason: `Auto-approved ${approval.kind} approval (${approval.title}) within the leash: ${reasoning}`.slice(0, 4000),
    metadata: { job_id: approval.jobId, kind: approval.kind },
  });
  return { ok: true };
}

/**
 * ESCALATE a routed approval UP to the CEO — re-route its inbox request (set routed_to_function='ceo' +
 * append the director's written diagnosis to the body) so it appears in the CEO inbox, and log the
 * escalation to [[approval-decisions]] (decision='escalated') + [[director-activity]]. The job STAYS
 * `needs_approval` (only the CEO can decide it now). Used for the high-stakes calls + any request the
 * director cannot confirm sound — uncertainty escalates, it never auto-approves.
 */
export async function directorEscalateApproval(
  admin: Admin,
  args: { workspaceId: string; approval: RoutedApproval; diagnosis: string },
): Promise<{ ok: boolean }> {
  const { workspaceId, approval, diagnosis } = args;
  // Re-route the existing inbox notification to the CEO (idempotent — reconcile won't overwrite it).
  const { data: notifRow } = await admin.from("dashboard_notifications").select("body, metadata").eq("id", approval.notificationId).maybeSingle();
  const notif = notifRow as { body: string | null; metadata: Record<string, unknown> | null } | null;
  if (notif) {
    const meta = { ...(notif.metadata ?? {}), routed_to_function: CEO };
    const body = `${notif.body ?? ""}\n\n[Platform Director escalation] ${diagnosis}`.slice(0, 4000);
    await admin.from("dashboard_notifications").update({ metadata: meta, body, read: false }).eq("id", approval.notificationId);
  }

  await recordApprovalDecision(admin, {
    workspaceId,
    agentJobId: approval.jobId,
    pendingActionId: approval.pendingActions[0]?.id ?? null,
    raisedByFunction: approval.raisedByFunction,
    routedToFunction: CEO,
    decidedBy: "director",
    decision: "escalated",
    reasoning: diagnosis,
    autonomous: true,
    metadata: { kind: approval.kind, spec_slug: approval.specSlug, leash: leashClass(approval) },
  });
  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: PLATFORM_DIRECTOR_FUNCTION,
    actionKind: "escalated",
    specSlug: approval.specSlug,
    reason: `Escalated ${approval.kind} approval (${approval.title}) to the CEO: ${diagnosis}`.slice(0, 4000),
    metadata: { job_id: approval.jobId, kind: approval.kind },
  });
  return { ok: true };
}

// ── The Max `claude -p` investigation (the "never rubber-stamp" confirm step) ─────────────────────

/** One verdict the director reaches per routed approval. */
export interface ApprovalVerdict {
  jobId: string;
  decision: "approve" | "escalate";
  reasoning: string;
}

/** Build the read-only brief the director investigates: each routed approval + its leash pre-class. */
export function platformDirectorBrief(approvals: RoutedApproval[]): string {
  if (approvals.length === 0) return "No routed Platform approvals are waiting.";
  const blocks = approvals.map((a, i) => {
    const cls = leashClass(a);
    const acts = a.pendingActions.map((p) => `    - [${p.type ?? "action"}] ${p.summary ?? ""}${p.cmd ? `\n      $ ${p.cmd}` : ""}`).join("\n");
    return [
      `(${i + 1}) jobId=${a.jobId}  kind=${a.kind}  spec=${a.specSlug ?? "—"}  pre-class=${cls}`,
      `    title: ${a.title}`,
      `    cause + proposed fix:`,
      `    ${a.body.replace(/\n/g, "\n    ").slice(0, 1500)}`,
      a.pendingActions.length ? `    pending actions an approve would execute:\n${acts}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `Routed Platform approvals awaiting your decision (${approvals.length}):\n\n${blocks.join("\n\n")}`;
}

/** The investigation prompt — confirm each routed approval is sound + low-risk + within the leash. */
export function platformDirectorPrompt(brief: string): string {
  return [
    `You are the Platform/DevOps Director (🛠️ Ada) running as the box's platform-director on Max (web search on, no API key, READ-ONLY prod access). You are the FIRST live director — you take the CEO out of platform operations by auto-approving the routine platform work the CEO currently rubber-stamps, while ESCALATING the genuinely high-stakes calls. You NEVER mutate in this pass and NEVER edit code: you INVESTIGATE each routed Approval Request read-only (cwd is the repo root — read docs/brain/ first, then src/), confirm its cause + proposed fix are SOUND, and decide per approval. The worker executes your approvals after this pass — not now.`,
    ``,
    `THE LEASH — you may AUTO-APPROVE (no CEO) only when ALL hold: the cause + fix are sound, the action is low-risk, and it is one of: an error fix · a db index / health change · an ADDITIVE / REVERSIBLE migration · milestone progression of an already-approved goal · a platform-monitoring fix.`,
    `You MUST ESCALATE to the CEO (never auto-approve) when ANY holds: a DESTRUCTIVE / irreversible action (a data-dropping migration, deleting infra) · modifying or abandoning an approved goal · STARTING A NEW goal (only the CEO greenlights goals) · a build that has repeatedly failed on the same error (a deeper issue) · OR you simply CANNOT confirm the request is sound. Uncertainty escalates — it never auto-approves. NEVER rubber-stamp.`,
    ``,
    brief,
    ``,
    `For EACH approval, decide one verdict and cite your reasoning (what the cause is, why the fix is sound + reversible, which leash bucket it falls in — or why it must escalate):`,
    `  • "approve" — sound + low-risk + within the leash. The worker will execute it.`,
    `  • "escalate" — high-stakes / irreversible / a new-or-modified goal / unconfirmable. Write a plain-text diagnosis the CEO reads to decide.`,
    ``,
    `Final message = ONLY one JSON object:`,
    `  {"verdicts":[{"jobId":"<the jobId>","decision":"approve"|"escalate","reasoning":"<plain text: cause + why sound/within-leash, or why it must escalate>"}],"board_update":"<ONE plain-text sentence, no markdown, in Ada's steady/blunt voice, summarising what you squashed / approved / escalated this pass for the #directors board>"}`,
  ].join("\n");
}
