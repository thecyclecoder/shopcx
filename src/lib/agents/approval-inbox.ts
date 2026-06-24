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
 * path is unchanged (POST /api/roadmap/approve → worker flips queued_resume). Phase 4 retired the
 * scattered surfaces (Control Tower repair/db-health feeds, spec cards, box approvalHref): they now
 * routedInboxHref()-deep-link into this one inbox, which decides plain approve/decline (incl. multi-
 * action build + multi-branch plan, inline) and deep-links only genuinely multi-choice actions out.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { MONITORED_LOOPS } from "@/lib/control-tower/registry";
import { MODEL_TIER_PROPOSAL_KIND, APPLY_MODEL_TIER_ACTION_TYPE } from "@/lib/agent-jobs";
import { APPROVAL_REQUEST_TYPE, type InboxApprovalAction } from "@/lib/agents/inbox";
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
  spec?: { title?: string; slug?: string; owner?: string; parent?: string } | null;
  // box-agent-model-tiers P3: on an apply_model_tier action, the agent kind whose tier changes — the
  // routing key (a worker's change routes to its director, a director's to the CEO).
  target_kind?: string;
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
  // `proposed-goal` (director-proposed-goals) is deliberately ABSENT — a goal NEVER routes to a director for
  // greenlight, even a live+autonomous one (a director may propose its own goal but never greenlight any).
  // Unmapped ⇒ ownerFunctionForKind returns null ⇒ resolveApprover falls through to the CEO. Do not add it.
  return m;
})();

export function ownerFunctionForKind(kind: string): string | null {
  return KIND_TO_FUNCTION[kind] ?? null;
}

/**
 * The function whose org-chart seat OWNS this job's raising tool — the input to `resolveApprover`.
 * For a `proposed-model-tier` job (box-agent-model-tiers P3) the request is ABOUT a target agent, so it
 * routes by the TARGET kind (read off the apply_model_tier action), not the proposal kind: a worker's
 * change resolves UP to its director, a director's own change is unmapped ⇒ the CEO. Every other kind
 * routes by its own kind, unchanged.
 */
export function routingOwnerForJob(job: { kind: string; pending_actions?: PendingActionLike[] | null }): string | null {
  if (job.kind === MODEL_TIER_PROPOSAL_KIND) {
    const a = (job.pending_actions || []).find((x) => x.type === APPLY_MODEL_TIER_ACTION_TYPE);
    if (a?.target_kind) return ownerFunctionForKind(a.target_kind);
  }
  return ownerFunctionForKind(job.kind);
}

/**
 * Where to DECIDE a genuinely multi-CHOICE action that the inbox's inline Approve/Decline can't express
 * (coverage register-vs-exempt, hero reject-with-notes). Phase 4 made the inbox the single source for
 * plain approve/decline (incl. multi-action/multi-branch), so this deep-link now only carries multi-choice
 * out to its canonical surface (coverage-register → the Control Tower coverage section; storefront → the
 * optimizer; the Control Tower default always loads). Plain kinds keep an informational spec/goal link.
 */
const SPEC_SLUG_KINDS = new Set(["build", "spec-test"]);
export function approvalDeepLink(kind: string, specSlug: string | null, specMissing?: boolean | null): string {
  if (kind === "plan") return `/dashboard/roadmap/goals/${specSlug ?? ""}`;
  if (kind === "proposed-goal") return `/dashboard/roadmap/goals/${specSlug ?? ""}`; // director-proposed-goals: greenlight surface
  if (kind === MODEL_TIER_PROPOSAL_KIND) return `/dashboard/agents/${encodeURIComponent(specSlug ?? "")}`; // box-agent-model-tiers: the target agent's profile
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

/**
 * Every pending plain action this job gates, each decided INLINE in the inbox with its own
 * Approve/Decline (approval-routing-engine Phase 4 — multi-action/multi-branch inline). Generalizes
 * `inlineApproveActionId` from the single-action case to the whole list, so a multi-action build or a
 * multi-branch plan is decided entirely in the inbox (retiring the spec-card / Control-Tower standalone
 * cards). Returns `null` (no inline decision) when ANY pending action is multi-CHOICE (coverage
 * register/exempt, hero reject-with-notes) — those can't be expressed as a binary, so the row falls
 * back to the `deep_link` canonical surface. An action with no id is skipped (can't be acted on).
 */
export function inlineApproveActions(job: ApprovalJobRow): InboxApprovalAction[] | null {
  const pending = pendingActions(job);
  if (!pending.length) return null;
  if (pending.some((a) => a.type && MULTI_CHOICE_TYPES.has(a.type))) return null;
  const actions = pending
    .filter((a) => a.id)
    .map((a) => ({
      id: a.id as string,
      summary: actionLabel(a),
      preview: a.preview ?? null,
      cmd: a.cmd ?? null,
      specOwner: a.spec?.owner ?? null,
      specParent: a.spec?.parent ?? null,
    }));
  return actions.length ? actions : null;
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
  const ownerFn = routingOwnerForJob(job);
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

  const { data: jobsData, error: jobsError } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, status, pending_actions, log_tail, spec_missing")
    .eq("status", "needs_approval")
    .limit(500);
  // SAFETY: never act on a FAILED read. A null/errored job query would otherwise look like "0 open jobs"
  // and the dismiss loop below would dismiss EVERY approval notification — one transient read wipes the
  // whole CEO inbox (observed 2026-06-24). On error, bail and leave the inbox untouched until the next tick.
  if (jobsError) {
    console.warn(`[approval-inbox] job read failed — skipping reconcile to protect the inbox: ${jobsError.message}`);
    return { created: 0, dismissed: 0 };
  }
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
