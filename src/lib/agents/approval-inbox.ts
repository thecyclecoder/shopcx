/**
 * Approval inbox emitter (approval-routing-engine spec, Phase 2) — route every agent_jobs
 * `needs_approval` row UP the org chart and surface it as a routed Approval Request in the M1
 * inbox, carrying the agent's investigation + proposed fix INLINE so the decision is one read.
 *
 * North star (operational-rules § supervisable autonomy): an approval answers to an objective-
 * owner. Phase 1 shipped the pure router (`resolveApprover`) + the live flags; this phase is the
 * one place that turns a raised `needs_approval` into a request in the resolved role's inbox.
 *
 * Single chokepoint — `reconcileApprovalInbox` is the reconciler the box worker runs each poll
 * tick. It is the "one inbox, no orphans" guarantee: it sweeps EVERY open `needs_approval` job
 * (regardless of which surface raised it — repair / db_health / coverage-register / plan /
 * migration-fix / storefront), emits a routed Approval Request for any that lacks one (idempotent
 * on `metadata.agent_job_id`), and dismisses the request the moment its job leaves needs_approval
 * (approved → queued_resume, declined, done) so the inbox never shows a stale gate.
 *
 * This milestone changes WHERE a request surfaces, not how an approved action runs — the execution
 * path is unchanged (POST /api/roadmap/approve → worker flips queued_resume). The richer scattered
 * surfaces (Control Tower feeds, spec cards, box approvalHref) keep working until Phase 4 retires
 * them; here we ADD the routed-inbox emission alongside them.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { MONITORED_LOOPS } from "@/lib/control-tower/registry";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import {
  resolveApprover,
  buildOrgChartGraph,
  loadAutonomyMap,
  CEO,
  type OrgChartGraph,
  type AutonomyMap,
} from "@/lib/agents/approval-router";

type Admin = ReturnType<typeof createAdminClient>;

/** One pending action as it lives on agent_jobs.pending_actions (the fields this emitter reads). */
interface PendingActionLike {
  id?: string;
  type?: string;
  status?: string;
  summary?: string;
  preview?: string;
  cmd?: string;
  spec_title?: string;
  spec?: { title?: string; slug?: string } | null;
}

/** The agent_jobs columns this emitter needs (a row that just entered, or sits in, needs_approval). */
export interface ApprovalJobRow {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string | null;
  status: string;
  pending_actions: PendingActionLike[] | null;
  log_tail?: string | null;
  spec_missing?: boolean | null;
}

/**
 * agent_jobs.kind → the org-chart FUNCTION that owns the raising tool. Most kinds are agent-kind
 * box lanes already tagged with an owner in the Control Tower registry (the single source of truth,
 * no second copy). The proposal kinds db_health / coverage-register raise agent_jobs but run as
 * platform crons, not agent-kind lanes — mapped explicitly. An unknown kind ⇒ null ⇒ resolveApprover
 * routes it to the CEO (fail-safe: an unmapped tool never silently routes to a director).
 */
const KIND_TO_FUNCTION: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const l of MONITORED_LOOPS) {
    if (l.kind === "agent-kind" && l.agentKind) m[l.agentKind] = l.owner;
  }
  if (!m["db_health"]) m["db_health"] = "platform";
  if (!m["coverage-register"]) m["coverage-register"] = "platform";
  return m;
})();

export function ownerFunctionForKind(kind: string): string | null {
  return KIND_TO_FUNCTION[kind] ?? null;
}

/**
 * Where to DECIDE a richer/multi-choice action that inline Approve/Decline can't express. Mirrors
 * the box page's approvalHref (the safe-by-default router: a real-spec/dedicated surface gets a deep
 * link, every other agent-proposal kind defaults to the Control Tower, which always loads). Phase 4
 * folds these surfaces into the routed inbox and retires this fallback.
 */
const SPEC_SLUG_KINDS = new Set(["build", "spec-test"]);
export function approvalDeepLink(kind: string, specSlug: string | null, specMissing?: boolean | null): string {
  if (kind === "plan") return `/dashboard/roadmap/goals/${specSlug ?? ""}`;
  if (kind === "migration-fix") return "/dashboard/migrations";
  if (kind === "storefront-optimizer") return "/dashboard/storefront/optimizer";
  if (SPEC_SLUG_KINDS.has(kind)) return specMissing || !specSlug ? "/dashboard/roadmap" : `/dashboard/roadmap/${specSlug}`;
  return "/dashboard/developer/control-tower";
}

/** Action types whose decision is more than approve/decline (register vs exempt, hero reject-with-notes). */
const MULTI_CHOICE_TYPES = new Set(["coverage_register", "storefront_campaign"]);

/** The still-pending actions on a job (default status 'pending' when absent). */
function pendingActions(job: ApprovalJobRow): PendingActionLike[] {
  return (job.pending_actions || []).filter((a) => (a.status ?? "pending") === "pending");
}

/**
 * The single action id inline Approve/Decline can act on, or null. Only offered when the job has
 * exactly ONE pending action that is a plain approve/decline (not a multi-choice type) — so the
 * inbox never guesses a register/exempt/preview decision; those fall back to the deep-link surface.
 */
export function inlineApproveActionId(job: ApprovalJobRow): string | null {
  const pending = pendingActions(job);
  if (pending.length !== 1) return null;
  const a = pending[0];
  if (!a.id) return null;
  if (a.type && MULTI_CHOICE_TYPES.has(a.type)) return null;
  return a.id;
}

function actionLabel(a: PendingActionLike): string {
  return a.summary || a.spec?.title || a.spec_title || "";
}

/** Build the inbox title + the investigation/proposed-fix INLINE body from the job's pending actions. */
export function buildApprovalContent(job: ApprovalJobRow): { title: string; body: string } {
  const pending = pendingActions(job);
  const headline = actionLabel(pending[0] ?? {}) || job.spec_slug || job.kind;
  const title = `${job.kind}: ${headline}`.slice(0, 200);

  const blocks: string[] = [];
  for (const a of pending) {
    const seg: string[] = [];
    const label = actionLabel(a);
    if (label) seg.push(label);
    if (a.preview) seg.push(a.preview);
    if (a.cmd) seg.push(`$ ${a.cmd}`);
    if (seg.length) blocks.push(seg.join("\n"));
  }
  let body = blocks.join("\n\n");
  if (!body && job.log_tail) body = job.log_tail;
  return { title, body: body.slice(0, 4000) };
}

/** The metadata blob carried on the routed Approval Request notification (drives the inbox API). */
interface ApprovalMeta {
  agent_job_id: string;
  kind: string;
  spec_slug: string | null;
  raised_by_function: string;
  routed_to_function: string;
  approve_action_id: string | null;
  deep_link: string;
}

/** Resolve + shape the notification fields for one job (pure given the chart + autonomy snapshot). */
export function buildApprovalNotification(
  job: ApprovalJobRow,
  chart: OrgChartGraph,
  autonomy: AutonomyMap,
): { workspace_id: string; type: string; title: string; body: string | null; link: string; metadata: ApprovalMeta; read: boolean; dismissed: boolean } {
  const ownerFn = ownerFunctionForKind(job.kind);
  const routedTo = resolveApprover(ownerFn, chart, autonomy);
  const { title, body } = buildApprovalContent(job);
  const link = approvalDeepLink(job.kind, job.spec_slug, job.spec_missing);
  const metadata: ApprovalMeta = {
    agent_job_id: job.id,
    kind: job.kind,
    spec_slug: job.spec_slug ?? null,
    raised_by_function: ownerFn ?? CEO,
    routed_to_function: routedTo,
    approve_action_id: inlineApproveActionId(job),
    deep_link: link,
  };
  return { workspace_id: job.workspace_id, type: APPROVAL_REQUEST_TYPE, title, body: body || null, link, metadata, read: false, dismissed: false };
}

/**
 * The reconciler — the single "one inbox, no orphans" sweep. Run it from the box worker poll loop.
 *   - For every open needs_approval job with NO routed Approval Request yet → emit one (idempotent
 *     on metadata.agent_job_id, so a job that re-parks to needs_approval doesn't double-emit).
 *   - For every live Approval Request whose job has LEFT needs_approval (approved/declined/done/gone)
 *     → dismiss it, so the inbox only ever shows requests still awaiting a decision.
 * Best-effort + bounded; never throws into the caller.
 */
export async function reconcileApprovalInbox(admin: Admin): Promise<{ created: number; dismissed: number }> {
  const [chart, autonomy] = await Promise.all([buildOrgChartGraph(), loadAutonomyMap()]);

  const { data: jobsData } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, status, pending_actions, log_tail, spec_missing")
    .eq("status", "needs_approval")
    .limit(500);
  const jobs = (jobsData ?? []) as ApprovalJobRow[];
  const openJobIds = new Set(jobs.map((j) => j.id));

  const { data: notifData } = await admin
    .from("dashboard_notifications")
    .select("id, metadata")
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("dismissed", false)
    .limit(2000);
  const notifs = (notifData ?? []) as { id: string; metadata: Record<string, unknown> | null }[];
  const emittedJobIds = new Set<string>();
  for (const n of notifs) {
    const jid = n.metadata?.["agent_job_id"];
    if (typeof jid === "string") emittedJobIds.add(jid);
  }

  let created = 0;
  for (const job of jobs) {
    if (emittedJobIds.has(job.id)) continue; // already surfaced — idempotent across re-parks
    const row = buildApprovalNotification(job, chart, autonomy);
    const { error } = await admin.from("dashboard_notifications").insert(row);
    if (!error) created++;
  }

  let dismissed = 0;
  for (const n of notifs) {
    const jid = n.metadata?.["agent_job_id"];
    if (typeof jid === "string" && !openJobIds.has(jid)) {
      const { error } = await admin.from("dashboard_notifications").update({ dismissed: true }).eq("id", n.id);
      if (!error) dismissed++;
    }
  }

  return { created, dismissed };
}
