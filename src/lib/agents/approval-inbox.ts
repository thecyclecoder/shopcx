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
import { getSlackToken, postAsAda, updateMessage } from "@/lib/slack";
import { buildInboxApprovalCard, type InboxCardAction } from "@/lib/slack-ada";
import { createChatModeInvitationThread } from "@/lib/agents/director-coach-threads";
import { getPr } from "@/lib/github-pr-resolve";

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
  // out-of-leash-approval-show-exact-cmd: true on a ceo-authorized-out-of-leash pending action so
  // the inbox card renders the literal `$ ${cmd}` alongside preview (not as a fallback).
  out_of_leash?: boolean;
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
  // growth-customer-voice-to-ad-angles Phase 3: a `growth-voice-angle-approval` target carries one
  // `approve_voice_angle` pending action per status='proposed' angle and routes UP from the Growth
  // function; while Growth is live+autonomous, the Growth director auto-approves within the leash,
  // otherwise it falls through to the CEO (the fail-safe).
  if (!m["growth-voice-angle-approval"]) m["growth-voice-angle-approval"] = "growth";
  // `research` (Rhea) is a Growth worker — any research agent_jobs she raises route UP from Growth
  // (Max auto-approves within his leash, else the CEO fail-safe), same as Cleo's grade lanes.
  if (!m["research"]) m["research"] = "growth";
  // `dr-content` (Carrie) is a Growth worker — her content-gap flags + build handoffs route UP from
  // Growth (Max), same leash. She reports to Max and escalates real-asset gaps to him.
  if (!m["dr-content"]) m["dr-content"] = "growth";
  // `sms-marketing` (Margo) is a CMO worker — her send proposals + stale-segment/no-coupon escalations
  // route UP from CMO (Iris auto-approves within her leash when live+autonomous, else the CEO fail-safe).
  if (!m["sms-marketing"]) m["sms-marketing"] = "cmo";
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
 *
 * destructive-migration-safety-rails Phase 4 + secure-destructive-migration-preapproval-boundary —
 * a raised out-of-leash action MAY carry a `routed_to_function_override` on its pending action
 * naming who OWNS the decision (Ada or CEO), computed by `routeOutOfLeashAction` from
 * (actionType × Phase-1 severity × Phase-2 rename-and-expire × business-materiality). We honor
 * the override ONLY when RE-VALIDATED at read-time against the action shape:
 *
 *   • job.kind must be `ceo-authorized-out-of-leash` (the only shape whose raiser sets an override);
 *   • the pending action's `type` must be `apply_migration` (a `run_prod_script` is a bounded shell
 *     command whose blast-radius the classifier cannot inspect — it can never earn a Platform lane);
 *   • the action's persisted `blastRadius.severity` must be `reversible_destructive` (additive still
 *     goes to CEO because Ada is out of leash; irreversible always to CEO circuit-breaker);
 *   • the override string must be one of the whitelist `'platform' | 'ceo'`.
 *
 * Any missed check → we IGNORE the override and fall through to the `KIND_TO_FUNCTION` default
 * (unmapped kind → null → CEO fail-safe). A hostile pending_actions row that hand-installs a
 * `routed_to_function_override: 'platform'` on a `run_prod_script` or on an unrelated job kind
 * cannot install a Platform override — the read-time gates re-derive the routing from the same
 * server-persisted facts the raise path did.
 */
export function routingOwnerForJob(job: { kind: string; pending_actions?: PendingActionLike[] | null }): string | null {
  if (job.kind === MODEL_TIER_PROPOSAL_KIND) {
    const a = (job.pending_actions || []).find((x) => x.type === APPLY_MODEL_TIER_ACTION_TYPE);
    if (a?.target_kind) return ownerFunctionForKind(a.target_kind);
  }
  const override = destructiveRouteOverride(job);
  if (override) return override;
  return ownerFunctionForKind(job.kind);
}

/**
 * Read the Phase-4 destructive-action routing override off a pending action, but ONLY after
 * re-validating the surrounding action shape at read-time (see `routingOwnerForJob` header).
 * Every other job kind + action shape ignores any override — this is the boundary that prevents
 * a hand-crafted `routed_to_function_override` field from silently installing a Platform route.
 */
function destructiveRouteOverride(job: { kind: string; pending_actions?: PendingActionLike[] | null }): string | null {
  if (job.kind !== "ceo-authorized-out-of-leash") return null;
  for (const a of job.pending_actions ?? []) {
    if (a.type !== "apply_migration") continue;
    const rec = a as unknown as Record<string, unknown>;
    const raw = rec["routed_to_function_override"];
    if (raw !== "platform" && raw !== "ceo") continue;
    const br = rec["blastRadius"];
    const severity = br && typeof br === "object" && typeof (br as { severity?: unknown }).severity === "string"
      ? (br as { severity: string }).severity
      : null;
    // Only `reversible_destructive` is eligible for a Platform lane. `additive` and
    // `irreversible_destructive` — plus any missing / malformed blastRadius — fall through
    // to CEO fail-safe.
    if (severity !== "reversible_destructive") continue;
    return raw;
  }
  return null;
}

/**
 * plan-approval-routes-by-goal-owner: a `plan` (goal-decomposition) job is RAISED by the planner (Pia,
 * a PLATFORM-supervised tool), but the approval it parks is ABOUT the GOAL it decomposed — the proposed
 * specs are owned by the goal's owner function, not the planner's. Routing it by the planner's function
 * (platform) lands it in Ada's inbox, where a goal owned by another department (e.g. growth) is out of
 * her leash AND the CEO's card has no Approve button (it's routed to Ada). That's the deadlock.
 *
 * So a plan job routes by its GOAL's owner function (`goals.owner` keyed by `job.spec_slug` — the plan
 * job's spec_slug IS the goal slug, per /api/roadmap/plan). `resolveApprover(goalOwner, …)` then walks
 * UP: a live+autonomous owner-director approves its own plan; otherwise the keystone fail-safe routes it
 * to the CEO (matching the goal page's "await YOUR approval"). Every OTHER kind routes unchanged.
 *
 * Async because it reads `public.goals`. Delegates to the sync `routingOwnerForJob` for non-plan kinds
 * and when the goal owner can't be resolved (a missing owner ⇒ the platform default ⇒ CEO via fail-safe —
 * never a silent auto-approve by the wrong director).
 */
export async function routingOwnerForJobAsync(
  admin: Admin,
  job: { kind: string; spec_slug?: string | null; workspace_id?: string; pending_actions?: PendingActionLike[] | null },
): Promise<string | null> {
  if (job.kind === "plan" && job.spec_slug) {
    const goalOwner = await resolveGoalOwnerFunction(admin, job.workspace_id ?? null, job.spec_slug);
    if (goalOwner) return goalOwner;
    // No goal row / no owner resolved → fall through to the kind default (platform), which the fail-safe
    // walk then sends to the CEO unless platform is live+autonomous. A plan must never silently auto-route
    // to a director on a missing goal — better the CEO sees it.
  }
  return routingOwnerForJob(job);
}

/** Resolve a goal's owner FUNCTION slug from `public.goals` (keyed by goal slug). Null on miss/error. */
export async function resolveGoalOwnerFunction(
  admin: Admin,
  workspaceId: string | null | undefined,
  goalSlug: string,
): Promise<string | null> {
  let q = admin.from("goals").select("owner").eq("slug", goalSlug);
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { data, error } = await q.limit(1).maybeSingle();
  if (error || !data) return null;
  const owner = (data as { owner?: unknown }).owner;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
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
      outOfLeash: a.out_of_leash === true,
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
  /**
   * The Slack #cto-ada message ts when the reconciler mirrored this request to Ada (ada-slack-
   * routed-approvals Phase 1). Set ONLY for CEO-routed plain-action approvals whose workspace has
   * `slack_ada_channel_id`. Read by the Phase 2 button handler + Phase 4 web-inbox mirror to
   * `chat.update` the card. Absent ⇒ no Slack card was posted.
   */
  slack_message_ts?: string;
  /**
   * Phase 3 (chat-mode): true when the Slack surface for this routed approval is a chat-style
   * invitation in a fresh thread (NOT an Approve/Reject card). The invitation's post `ts` is still
   * stored on `slack_message_ts`, so the dismiss-pass thread reply + Phase 4 web→Slack mirror still
   * key off it; this flag just tells those surfaces "the message they're updating is an invitation,
   * not a card." Absent ⇒ the surface was a Block Kit card (Phase 1).
   */
  slack_chat_mode?: boolean;
  /**
   * Phase 3 (chat-mode): the `director_coach_threads.id` created alongside the invitation post —
   * the same row the Slack events handler resumes when the founder replies in the thread.
   */
  coach_thread_id?: string;
}

/**
 * Resolve + shape the notification fields for one job (pure given the chart + autonomy snapshot).
 *
 * `ownerFnOverride` (plan-approval-routes-by-goal-owner): the async-resolved routing owner the reconciler
 * passes in for a `plan` job (its GOAL's owner, not the planner's platform default). When absent, the sync
 * `routingOwnerForJob` is used — correct for every non-plan kind, which is owner-derivable without a DB read.
 */
export function buildApprovalNotification(
  job: ApprovalJobRow,
  chart: OrgChartGraph,
  autonomy: AutonomyMap,
  ownerFnOverride?: string | null,
): { workspace_id: string; type: string; title: string; body: string | null; link: string; metadata: ApprovalMeta; read: boolean; dismissed: boolean } {
  const ownerFn = ownerFnOverride !== undefined ? ownerFnOverride : routingOwnerForJob(job);
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

type AdaSurfaceCache = Map<string, { channelId: string | null; token: string | null }>;

/**
 * Read the workspace's Ada-channel surface (channel id + bot token), cached for the sweep. A
 * workspace without `slack_ada_channel_id` set returns `{channelId:null}` and we skip the Slack
 * emit — `#cto-ada` is opt-in per workspace.
 */
async function loadAdaSurface(admin: Admin, workspaceId: string, cache: AdaSurfaceCache): Promise<{ channelId: string | null; token: string | null }> {
  const hit = cache.get(workspaceId);
  if (hit) return hit;
  const { data } = await admin
    .from("workspaces")
    .select("slack_ada_channel_id")
    .eq("id", workspaceId)
    .maybeSingle();
  const channelId = (data?.slack_ada_channel_id as string | null) ?? null;
  const token = channelId ? await getSlackToken(workspaceId) : null;
  const entry = { channelId, token };
  cache.set(workspaceId, entry);
  return entry;
}

/**
 * The investigation-preview length above which a routed approval qualifies for chat-mode — a wall
 * of diff isn't a card the founder should blind-approve (ada-slack-routed-approvals Phase 3).
 */
const CHAT_MODE_PREVIEW_LIMIT = 1200;

/**
 * Phase 3 (ada-slack-routed-approvals): does this routed CEO approval warrant a chat-style
 * invitation instead of an Approve/Reject card? True when ANY:
 *   - `inlineApproveActions` returns null (multi-choice — coverage_register / storefront hero
 *     reject-with-notes / a multi-branch plan — can't be expressed as binary buttons);
 *   - the job's kind is brain-touching (`proposed-goal` — a new objective; the CEO never
 *     greenlights one as a card tap);
 *   - any pending action is a planner-proposed `spec` (it commits a brain page);
 *   - the investigation preview exceeds CHAT_MODE_PREVIEW_LIMIT (blind-approving a wall of diff
 *     is the failure mode this guards against).
 * False ⇒ the routine card path (Phase 1) — which is the bulk of the queue.
 */
function shouldUseChatMode(
  job: ApprovalJobRow,
  row: ReturnType<typeof buildApprovalNotification>,
): boolean {
  if (!inlineApproveActions(job)) return true;
  if (job.kind === "proposed-goal") return true;
  if ((job.pending_actions ?? []).some((a) => a.type === "spec")) return true;
  if ((row.body?.length ?? 0) > CHAT_MODE_PREVIEW_LIMIT) return true;
  return false;
}

/**
 * The workspace owner's user_id — the founder we attribute the chat-mode thread to. Without one
 * mapped, the events handler's owner gate would reject any reply the founder typed (channel
 * membership is not authorization), so the invitation would be a dead end — we skip it. Routine
 * card-path approvals don't need this lookup (the buttons re-resolve the actor on tap).
 */
async function loadWorkspaceOwnerUserId(admin: Admin, workspaceId: string): Promise<string | null> {
  const { data } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("role", "owner")
    .maybeSingle();
  return (data?.user_id as string | null) ?? null;
}

/**
 * One short Slack-mrkdwn invitation summarizing why the founder shouldn't blind-approve this one —
 * the conversational opening line of a chat-mode thread (ada-slack-routed-approvals Phase 3). The
 * spec's example: "PR #521 (spec-status-db-driven Phase 1) paused for your call. It's foundational
 * — touches every status reader/writer. Reversible, but worth talking through. Want to walk
 * through it?" We don't have all that context (PR # / reversibility) for an arbitrary job, so we
 * synthesize the closest we can from the job kind + the trigger that flipped chat-mode on.
 */
function buildChatModeInvitationText(
  job: ApprovalJobRow,
  row: ReturnType<typeof buildApprovalNotification>,
): string {
  const headline = row.title;
  const reason = (() => {
    if (job.kind === "proposed-goal") return "It's a new goal — worth talking through before I greenlight.";
    if ((job.pending_actions ?? []).some((a) => a.type === "spec")) return "It's foundational — commits a spec into the brain.";
    if (!inlineApproveActions(job)) return "Multiple paths here — better to choose together than blind-pick.";
    if ((row.body?.length ?? 0) > CHAT_MODE_PREVIEW_LIMIT) return "The investigation runs long — better to talk it through than blind-approve.";
    return "Worth a quick conversation before I greenlight.";
  })();
  return `${headline} paused for your call. ${reason} Want to walk through it?`;
}

/**
 * Mirror a freshly inserted routed Approval Request into Slack #cto-ada as Ada (ada-slack-routed-
 * approvals Phase 1+3) — TOP-LEVEL post, never threaded into an active coach thread. Conditions:
 * (1) the request routed to the CEO (a director's own queue stays in the dashboard), (2) the
 * workspace has an Ada channel configured + a bot token. The surface forks on chat-mode
 * eligibility (Phase 3): a routine approval gets a Block Kit Approve/Reject card; a complex one
 * (multi-choice action, brain-touching kind, or wall-of-diff preview) gets a chat-style invitation
 * opening a director_coach_threads conversation. On a successful post, the message `ts` is stashed
 * onto the notification's metadata so a later `chat.update` (resolve / web-inbox mirror) can find
 * it. Best-effort — a Slack failure never rolls back the inbox row (the web inbox is still the
 * source of truth).
 */
async function mirrorToAdaSlackInbox(
  admin: Admin,
  job: ApprovalJobRow,
  row: ReturnType<typeof buildApprovalNotification>,
  notificationId: string,
  cache: AdaSurfaceCache,
): Promise<void> {
  if (row.metadata.routed_to_function !== CEO) return;
  const surface = await loadAdaSurface(admin, job.workspace_id, cache);
  if (!surface.channelId || !surface.token) return;

  if (shouldUseChatMode(job, row)) {
    await postChatModeInvitation(admin, job, row, notificationId, surface);
    return;
  }

  const actions = inlineApproveActions(job);
  if (!actions) return; // shouldUseChatMode covers the multi-choice case; defensive guard.

  const card = buildInboxApprovalCard({
    notificationId,
    title: row.title,
    body: row.body ?? "",
    actions: actions.map((a) => ({ id: a.id, summary: a.summary })),
  });
  const post = await postAsAda(surface.token, surface.channelId, card.blocks, card.text);
  if (!post.ok || !post.ts) return;

  // Stash the posted message ts on the notification metadata so the dismiss pass + Phase 4 mirror
  // can chat.update the card. The reconciler's job-id-based idempotency already prevents a re-park
  // from double-posting; slack_message_ts is the read-path key for the resolve/update surfaces.
  const nextMeta = { ...row.metadata, slack_message_ts: post.ts };
  await admin.from("dashboard_notifications").update({ metadata: nextMeta }).eq("id", notificationId);
}

/**
 * Phase 3 (ada-slack-routed-approvals): post Ada's chat-style invitation for one complex routed
 * approval and key a director_coach_threads row off the post's ts so a founder reply in the thread
 * resumes the same conversation (the existing events handler picks it up via
 * `findThreadBySlackThreadTs` — no new path). The thread's `metadata` carries the approval's
 * context (agent_job_id, notification_id, spec_slug, kind, investigation preview) so the box turn
 * knows what's being discussed without re-deriving it. Idempotency is shared with the card path:
 * we stash the same `slack_message_ts` (+ a chat_mode flag) on the notification so the dismiss
 * pass + the Phase 4 web→Slack mirror reuse the same key.
 *
 * The chat-mode invitation does NOT replace the web inbox row — the founder can still decide
 * there if they prefer. The Slack thread is the opt-in conversational surface for items that
 * shouldn't be one-tap.
 */
async function postChatModeInvitation(
  admin: Admin,
  job: ApprovalJobRow,
  row: ReturnType<typeof buildApprovalNotification>,
  notificationId: string,
  surface: { channelId: string | null; token: string | null },
): Promise<void> {
  if (!surface.channelId || !surface.token) return;
  // Without a mapped owner, a Slack reply would fail the events handler's owner re-gate — the
  // invitation would dangle. Skip the chat-mode emit; the web inbox row still exists as fallback.
  const ownerUserId = await loadWorkspaceOwnerUserId(admin, job.workspace_id);
  if (!ownerUserId) return;

  const invitation = buildChatModeInvitationText(job, row);
  const post = await postAsAda(surface.token, surface.channelId, [], invitation);
  if (!post.ok || !post.ts) return;

  // Pre-seed the thread with the approval's context. The box turn reads this on resume so the
  // founder's "yeah let's talk" lands with full context already loaded.
  const threadMetadata: Record<string, unknown> = {
    chat_mode: true,
    agent_job_id: job.id,
    notification_id: notificationId,
    spec_slug: job.spec_slug ?? null,
    kind: job.kind,
    investigation: (row.body ?? "").slice(0, 4000),
  };

  const created = await createChatModeInvitationThread({
    workspaceId: job.workspace_id,
    userId: ownerUserId,
    invitation,
    slackChannelId: surface.channelId,
    slackThreadTs: post.ts,
    metadata: threadMetadata,
  });

  // Stash slack_message_ts (+ the chat_mode flag + the coach thread id) on the notification so the
  // dismiss pass + Phase 4 web→Slack mirror can find the invitation post. Without the thread id
  // landing, we still record slack_message_ts so the post isn't double-posted on a re-park.
  const nextMeta: Record<string, unknown> = {
    ...row.metadata,
    slack_message_ts: post.ts,
    slack_chat_mode: true,
  };
  if (created?.id) nextMeta.coach_thread_id = created.id;
  await admin.from("dashboard_notifications").update({ metadata: nextMeta }).eq("id", notificationId);
}

/**
 * one-card-per-park: the job id a notification is ABOUT, read off whichever metadata key carried it.
 * The reconciler's routed Approval Requests carry `agent_job_id`; the director park escalators
 * (`escalateDiagnosisToCeo` triage/backstop/design-change) and the system age-alarm carry `job_id`.
 * Either uniquely identifies the same parked `agent_jobs` row — so the dedup + auto-clear passes can
 * collapse the 2–3 surfaces a single park otherwise spawns into ONE card.
 */
export function notifJobId(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const a = metadata["agent_job_id"];
  if (typeof a === "string" && a) return a;
  const b = metadata["job_id"];
  if (typeof b === "string" && b) return b;
  return null;
}

/**
 * one-card-per-park (DEDUP): is there ALREADY an active (non-dismissed) CEO card for this parked
 * `agent_jobs` row? ANY park surface counts — a routed Approval Request (`agent_approval_request`,
 * keyed on `agent_job_id`) OR a director park escalation / system age-alarm (keyed on `job_id`). The
 * three park emitters ("Parked {kind}" triage · "Park needs eyes" backstop · "Parked >70 min" age
 * alarm — plus the design-change chat invite) each call this BEFORE inserting, so a single parked job
 * surfaces AT MOST ONE card: whichever emitter fires first wins, the rest gate off. Two narrow
 * filtered reads (one per metadata key) rather than a JS scan, so it's cheap to call per row.
 * Best-effort: a read error returns false (better a rare duplicate than a suppressed escalation).
 */
export async function activeParkCardExistsForJob(admin: Admin, workspaceId: string, jobId: string): Promise<boolean> {
  for (const key of ["agent_job_id", "job_id"]) {
    const { data, error } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("dismissed", false)
      .filter(`metadata->>${key}`, "eq", jobId)
      .limit(1);
    if (error) continue; // fail-open: never suppress an escalation on a transient read error
    if ((data ?? []).length > 0) return true;
  }
  return false;
}

/**
 * The director-emitted PARK escalation_kinds (every surface `escalateDiagnosisToCeo` raises for a
 * needs_attention park) whose card auto-clears once its reason is gone. NON-park escalations
 * (loop_guard / groom_unsure / init-unsure / new_goal / external_blocker / deploy_rollback …) are
 * deliberately EXCLUDED — those answer to a different condition and must not be auto-dropped here.
 */
const PARK_ESCALATION_KINDS: ReadonlySet<string> = new Set(["needs_attention", "park_backstop", "park_design_change"]);
/** The system age-alarm marker (`metadata.kind`) — the "Parked >70 min" no-parked-specs invariant card. */
const PARK_AGE_ALARM_KIND = "no_parked_specs_invariant";
/** Spec statuses that mean "the work is done / superseded" — a park on one of these is obsolete. */
const SPEC_DONE_STATUSES: ReadonlySet<string> = new Set(["folded", "shipped"]);

/** A live park card the auto-clear pass evaluates (a director escalation OR a system age-alarm). */
interface ParkCardRow {
  id: string;
  workspace_id: string;
  metadata: Record<string, unknown> | null;
}

/** Live GitHub PR state as observed by `getPr` — `{ok:false}` folded in as the read-failure case. */
type PrReadOutcome =
  | { ok: true; merged: boolean; state: string; closedAt: string | null }
  | { ok: false };

/**
 * pr-resolve-park-clears-on-pr-merged (pure decision helper) — should the pr-resolve park card auto-
 * clear given the PR's live GitHub state? CONSERVATIVE: only clears on a POSITIVELY-observed merged
 * OR closed PR. A failed read (`!ok`) → keep (never clear on a null); a still-open PR → keep. Split
 * out from `reconcileStaleParkCards` so the SAFETY predicate is unit-testable end-to-end without
 * mocking the whole supabase + fetch stack. See [[../../docs/brain/libraries/approval-inbox.md]].
 */
export function prResolveParkOutcome(
  pr: PrReadOutcome,
): { action: "clear"; outcome: "merged" | "closed" } | { action: "keep"; reason: "read_failed" | "still_open" } {
  if (!pr.ok) return { action: "keep", reason: "read_failed" };
  if (pr.merged) return { action: "clear", outcome: "merged" };
  if (pr.state !== "open") return { action: "clear", outcome: "closed" };
  return { action: "keep", reason: "still_open" };
}

/** Dismiss one stale park card + log why. Best-effort; a failed update just leaves it for next tick. */
async function dismissParkCard(admin: Admin, id: string, reason: string): Promise<boolean> {
  const { error } = await admin.from("dashboard_notifications").update({ dismissed: true }).eq("id", id);
  if (error) {
    console.warn(`[approval-inbox] stale-park dismiss failed for ${id}: ${error.message}`);
    return false;
  }
  console.log(`[approval-inbox] auto-cleared stale park card ${id.slice(0, 8)} — ${reason}`);
  return true;
}

/**
 * one-card-per-park (AUTO-CLEAR): dismiss an active park/escalation card the moment its underlying
 * reason is genuinely gone, so the CEO inbox never inflates with obsolete parks. Idempotent (runs
 * every tick inside `reconcileApprovalInbox`), logged, and CONSERVATIVE — it only clears on a
 * definitively-resolved reason, never on a still-valid escalation (a real failing spec-test or a
 * genuine needs_human stays put).
 *
 * Two card families, each with its own "reason gone" test:
 *
 *  1. Job-backed park cards (triage "Parked {kind}", backstop "Park needs eyes", design-change chat,
 *     and the system "Parked >70 min" age alarm — all carry `metadata.job_id`):
 *       - the `agent_jobs` row is GONE or no longer `needs_attention` (it was dismissed / resolved /
 *         re-queued, e.g. the pr-878 resolver bug got fixed) → reason gone → dismiss.
 *       - the row is STILL needs_attention but its spec is `folded` (the CEO folded it as superseded,
 *         or it shipped+folded clean) → the park is obsolete → dismiss. (A merely-`shipped`-by-rollup
 *         spec whose job is still parked is NOT cleared on status alone — a genuine spec-test park on
 *         a shipped spec must survive; only the `agent_jobs` leaving needs_attention clears it.)
 *       - the row is STILL needs_attention AND its `kind='pr-resolve'` (a
 *         [[../github-pr-resolve.ts]] `surfaceExhaustedPrResolve` sentinel — the pr-N slug is
 *         SYNTHETIC, so the folded-spec branch above can never match): read the PR's live GitHub
 *         state via `getPr(pr_number)`; if the PR is MERGED or CLOSED, flip the sentinel job to
 *         `completed` with a log_tail breadcrumb (so it can't re-surface) AND dismiss the card —
 *         the same two-step the CEO did by hand for pr-1010 on 2026-07-02. CONSERVATIVE: on ANY
 *         GitHub read failure (`{ok:false}`) leave the card alone (never clear on a null read); a
 *         still-open+dirty PR keeps its card (the human still has to look).
 *
 *  2. Reva "Ambiguous post-deploy signal" cards (escalation_kind `deploy_unsure`, no agent_job — keyed
 *     on `metadata.spec_slug` + `deploy_watch_id`): the ambiguous signal has RESOLVED when the spec has
 *     since shipped/folded clean AND no NEW (non-baseline) error_events landed in the deploy's canary
 *     window. Both must hold — a fresh in-window error keeps the card (the signal was real after all).
 *
 * Returns the count cleared. Best-effort; a single failure never aborts the pass.
 */
export async function reconcileStaleParkCards(admin: Admin): Promise<number> {
  const { data: notifData, error } = await admin
    .from("dashboard_notifications")
    .select("id, workspace_id, metadata")
    .in("type", [APPROVAL_REQUEST_TYPE, "system"])
    .eq("dismissed", false)
    .limit(2000);
  // SAFETY: never act on a FAILED read (a null result would look like "no cards" but clears nothing —
  // harmless here, but we bail explicitly so a transient error is visible rather than silently no-op).
  if (error) {
    console.warn(`[approval-inbox] stale-park read failed — skipping auto-clear this tick: ${error.message}`);
    return 0;
  }
  const notifs = (notifData ?? []) as ParkCardRow[];

  // Partition the live cards into the two park families (everything else — routed approvals, non-park
  // escalations — is left untouched).
  const jobCards: Array<{ card: ParkCardRow; jobId: string }> = [];
  const revaCards: Array<{ card: ParkCardRow; specSlug: string | null; watchId: string | null }> = [];
  for (const n of notifs) {
    const m = n.metadata ?? {};
    const escKind = typeof m["escalation_kind"] === "string" ? (m["escalation_kind"] as string) : null;
    const metaKind = typeof m["kind"] === "string" ? (m["kind"] as string) : null;
    if (escKind === "deploy_unsure") {
      revaCards.push({
        card: n,
        specSlug: typeof m["spec_slug"] === "string" ? (m["spec_slug"] as string) : null,
        watchId: typeof m["deploy_watch_id"] === "string" ? (m["deploy_watch_id"] as string) : null,
      });
      continue;
    }
    const isPark = (escKind !== null && PARK_ESCALATION_KINDS.has(escKind)) || metaKind === PARK_AGE_ALARM_KIND;
    if (!isPark) continue;
    const jobId = notifJobId(m);
    if (jobId) jobCards.push({ card: n, jobId });
  }

  let cleared = 0;

  // ── Family 1: job-backed park cards ──────────────────────────────────────────
  if (jobCards.length) {
    const jobIds = Array.from(new Set(jobCards.map((c) => c.jobId)));
    const { data: jobsData } = await admin
      .from("agent_jobs")
      .select("id, workspace_id, status, spec_slug, kind, pr_number")
      .in("id", jobIds);
    const jobs = new Map<string, { workspace_id: string; status: string; spec_slug: string | null; kind: string; pr_number: number | null }>();
    for (const j of (jobsData ?? []) as Array<{ id: string; workspace_id: string; status: string; spec_slug: string | null; kind: string; pr_number: number | null }>) {
      jobs.set(j.id, { workspace_id: j.workspace_id, status: j.status, spec_slug: j.spec_slug, kind: j.kind, pr_number: j.pr_number });
    }
    // Batch-fetch the spec statuses for jobs STILL needs_attention (to catch a CEO-folded park).
    const stillParkedSlugs = new Set<string>();
    for (const { jobId } of jobCards) {
      const job = jobs.get(jobId);
      if (job && job.status === "needs_attention" && job.spec_slug) stillParkedSlugs.add(job.spec_slug);
    }
    const specStatus = await loadSpecStatuses(admin, stillParkedSlugs);

    for (const { card, jobId } of jobCards) {
      const job = jobs.get(jobId);
      if (!job) {
        // The job row is gone entirely — nothing left to decide.
        if (await dismissParkCard(admin, card.id, `job ${jobId.slice(0, 8)} no longer exists`)) cleared++;
        continue;
      }
      if (job.status !== "needs_attention") {
        // Resolved / dismissed / re-queued — the park reason is gone (e.g. pr-878 after the fix landed).
        if (await dismissParkCard(admin, card.id, `job ${jobId.slice(0, 8)} left needs_attention (now '${job.status}')`)) cleared++;
        continue;
      }
      // Still parked — only clear if the spec was FOLDED (superseded by the CEO / folded clean). A
      // genuine still-failing park keeps its card.
      const status = job.spec_slug ? specStatus.get(job.spec_slug) : null;
      if (status === "folded") {
        if (await dismissParkCard(admin, card.id, `spec ${job.spec_slug} is folded — park superseded`)) cleared++;
        continue;
      }
      // pr-resolve-park-clears-on-pr-merged — a still-parked pr-resolve sentinel (kind='pr-resolve',
      // synthetic pr-N slug, no real spec row so the folded branch above can never match) auto-clears
      // when its underlying PR is MERGED or CLOSED on GitHub. Two-step, mirroring the manual pr-1010 fix
      // on 2026-07-02: flip the sentinel job off needs_attention → 'completed' with a breadcrumb (so a
      // later reconciler tick can't re-emit a card for the same job), THEN dismiss the card. CONSERVATIVE:
      // on any GitHub read failure `getPr` returns `{ok:false}` → we skip, keeping the card (never
      // silently clear on a null read). A still-open PR keeps its card too — a human needs to see it.
      //
      // pr-resolve-park-conditional-state-update — the update is CONDITIONAL on the state we observed:
      //   (a) workspace_id-scoped — a card in workspace A must never flip a job that belongs to
      //       workspace B (the read across `.in("id", jobIds)` is workspace-agnostic, so a stray metadata
      //       pointer could otherwise cross workspaces here).
      //   (b) status='needs_attention' + kind='pr-resolve' + pr_number-scoped — if the job left
      //       needs_attention (was re-queued, dismissed, resolved by another path) between our read and
      //       the update, or its kind/pr_number changed, the update matches ZERO rows and we DO NOT
      //       dismiss the card; the next reconciliation pass re-evaluates against fresh state.
      // `.select("id")` returns the updated rows so we can assert exactly ONE row transitioned; anything
      // else (0 rows raced or filtered, >1 defensively impossible on a PK-scoped update) keeps the card.
      if (job.kind === "pr-resolve" && job.pr_number != null) {
        if (job.workspace_id !== card.workspace_id) continue; // workspace mismatch — never cross workspaces
        const decision = prResolveParkOutcome(await getPr(job.pr_number));
        if (decision.action === "keep") continue; // read_failed or still_open — CONSERVATIVE keep
        const outcome = decision.outcome; // 'merged' | 'closed'
        const { data: updated, error: upErr } = await admin
          .from("agent_jobs")
          .update({
            status: "completed",
            log_tail: `pr-resolve sentinel auto-cleared: PR #${job.pr_number} ${outcome} on GitHub (reconciler-observed ${new Date().toISOString()})`.slice(-2000),
          })
          .eq("id", jobId)
          .eq("workspace_id", job.workspace_id)
          .eq("status", "needs_attention")
          .eq("kind", "pr-resolve")
          .eq("pr_number", job.pr_number)
          .select("id");
        if (upErr) {
          console.warn(`[approval-inbox] pr-resolve sentinel flip failed for ${jobId.slice(0, 8)} (PR #${job.pr_number}): ${upErr.message}`);
          continue; // couldn't flip → don't drop the card
        }
        if (!updated || updated.length !== 1) {
          // Concurrent transition (the job left needs_attention between the read and the update, or a
          // kind/pr_number/workspace filter no longer matches) — leave the card active for the next
          // reconciler pass. Never dismiss a card we didn't authoritatively flip.
          continue;
        }
        if (await dismissParkCard(admin, card.id, `pr-resolve sentinel: PR #${job.pr_number} ${outcome} on GitHub — park superseded`)) cleared++;
      }
    }
  }

  // ── Family 1b: spec-slug-keyed park cards WITHOUT a job_id ────────────────────
  // Director "Parked {kind}" escalations (escalated_by_director, e.g. "Parked spec-test: {slug}") carry
  // `spec_slug` + `escalation_kind` but NO job_id, so Family 1 (which keys on notifJobId) SKIPS them — they
  // linger forever after their job resolves or their spec is deleted. This is what left week-old spec-test
  // parks + the pm-detail-page deleted-spec parks in the CEO inbox (hand-dismissed 2026-07-02). REASON-GONE
  // test on the SLUG: no agent_job for it is still `needs_attention` (the parked job resolved / was deleted
  // with its spec), OR the spec has folded. CONSERVATIVE: a slug that STILL has a needs_attention job keeps
  // its card, and a FAILED read of the live-park set leaves every card untouched (never clear on a null read).
  const specKeyedParks: Array<{ card: ParkCardRow; specSlug: string }> = [];
  for (const n of notifs) {
    const m = n.metadata ?? {};
    const escKind = typeof m["escalation_kind"] === "string" ? (m["escalation_kind"] as string) : null;
    if (escKind === null || !PARK_ESCALATION_KINDS.has(escKind)) continue;
    if (notifJobId(m)) continue; // job-backed → Family 1 already handled it
    const slug = typeof m["spec_slug"] === "string" && m["spec_slug"] ? (m["spec_slug"] as string) : null;
    if (slug) specKeyedParks.push({ card: n, specSlug: slug });
  }
  if (specKeyedParks.length) {
    const slugs = new Set(specKeyedParks.map((c) => c.specSlug));
    const { data: liveParks, error: liveErr } = await admin
      .from("agent_jobs")
      .select("spec_slug")
      .eq("status", "needs_attention")
      .in("spec_slug", Array.from(slugs));
    if (liveErr) {
      // SAFETY: a failed live-park read would make every slug look "resolved" — bail so a transient error
      // never mass-dismisses genuine parks. Next tick retries.
      console.warn(`[approval-inbox] Family 1b live-park read failed — skipping spec-keyed auto-clear this tick: ${liveErr.message}`);
    } else {
      const liveParkedSlugs = new Set(
        ((liveParks ?? []) as Array<{ spec_slug: string | null }>).map((j) => j.spec_slug).filter((s): s is string => Boolean(s)),
      );
      const specStatus = await loadSpecStatuses(admin, slugs);
      for (const { card, specSlug } of specKeyedParks) {
        if (liveParkedSlugs.has(specSlug)) continue; // a job for this slug is still parked — keep the card
        const status = specStatus.get(specSlug);
        const reason =
          status === undefined
            ? `spec ${specSlug} no longer exists — park superseded`
            : status === "folded"
              ? `spec ${specSlug} folded — park superseded`
              : `no needs_attention job remains for ${specSlug} — park resolved`;
        if (await dismissParkCard(admin, card.id, reason)) cleared++;
      }
    }
  }

  // ── Family 2: Reva "Ambiguous post-deploy signal" cards ──────────────────────
  if (revaCards.length) {
    const slugs = new Set<string>();
    for (const r of revaCards) if (r.specSlug) slugs.add(r.specSlug);
    const specStatus = await loadSpecStatuses(admin, slugs);
    for (const r of revaCards) {
      if (!r.specSlug) continue; // can't evaluate without a spec to confirm clean
      const status = specStatus.get(r.specSlug);
      if (!status || !SPEC_DONE_STATUSES.has(status)) continue; // spec hasn't shipped/folded yet — keep
      if (!(await deployWindowIsClean(admin, r.watchId))) continue; // a real in-window error → keep
      if (await dismissParkCard(admin, r.card.id, `deploy of ${r.specSlug} shipped clean (${status}), no new in-window errors — ambiguous signal resolved`)) cleared++;
    }
  }

  return cleared;
}

/** Batch-load `specs.status` keyed by slug for the given slugs (workspace-agnostic; slugs are unique enough). */
async function loadSpecStatuses(admin: Admin, slugs: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!slugs.size) return out;
  const { data } = await admin.from("specs").select("slug, status").in("slug", Array.from(slugs));
  for (const s of (data ?? []) as Array<{ slug: string; status: string | null }>) {
    if (s.status) out.set(s.slug, s.status);
  }
  return out;
}

/**
 * Reva auto-clear guard: did the deploy's canary window stay CLEAN — i.e. no NEW (non-baseline)
 * error signature first-seen inside [deployed_at, window_ends_at]? Reads the `deploy_watches` row by
 * id (its pre-deploy baseline + window bounds) and re-samples `error_events`. Returns true (clean) when
 * the in-window ambiguous signal is no longer present, so the card can be cleared. Fail-CLOSED: a
 * missing watch / read error returns false (keep the card) — we never drop a Reva escalation we can't
 * positively confirm resolved.
 */
async function deployWindowIsClean(admin: Admin, watchId: string | null): Promise<boolean> {
  if (!watchId) return false;
  const { data: watch, error } = await admin
    .from("deploy_watches")
    .select("deployed_at, window_ends_at, baseline")
    .eq("id", watchId)
    .maybeSingle();
  if (error || !watch) return false;
  const w = watch as { deployed_at: string; window_ends_at: string; baseline: { errorSignatures?: string[] } | null };
  const baseline = new Set((w.baseline?.errorSignatures ?? []).filter(Boolean));
  const { data: errs, error: errErr } = await admin
    .from("error_events")
    .select("signature")
    .gt("first_seen_at", w.deployed_at)
    .lte("first_seen_at", w.window_ends_at);
  if (errErr) return false; // can't confirm clean → keep the card
  for (const r of (errs ?? []) as Array<{ signature: string | null }>) {
    if (r.signature && !baseline.has(r.signature)) return false; // a genuine new in-window error remains
  }
  return true;
}

/**
 * The reconciler — the single "one inbox, no orphans" sweep. Run it from the box worker poll loop.
 *   - For every open needs_approval job with NO routed Approval Request yet → emit one (idempotent
 *     on metadata.agent_job_id, so a job that re-parks to needs_approval doesn't double-emit).
 *   - For every live Approval Request whose job has LEFT needs_approval (approved/declined/done/gone)
 *     → dismiss it, so the inbox only ever shows requests still awaiting a decision.
 *   - AUTO-CLEAR stale PARK cards (reconcileStaleParkCards): a director park escalation / system age
 *     alarm whose reason is gone (job left needs_attention, spec folded, Reva signal resolved clean).
 * Best-effort + bounded; never throws into the caller.
 */
export async function reconcileApprovalInbox(admin: Admin): Promise<{ created: number; dismissed: number; parksCleared: number }> {
  const [chart, autonomy] = await Promise.all([buildOrgChartGraph(), loadAutonomyMap()]);

  const { data: jobsData, error: jobsError } = await admin
    .from("agent_jobs")
    // spec_missing is a COMPUTED field (specMissing(kind,slug) in the box route — "the spec page would
    // 404 because it's folded/archived"), NOT an agent_jobs column. Selecting it threw "column
    // agent_jobs.spec_missing does not exist", which failed this read EVERY tick — and the bail-on-error
    // guard below then returned early forever, so approved jobs never advanced (the first real approval,
    // a migration script-approval, wedged on this). It's left off the select; the deep-link defaults to a
    // live spec (correct for an open needs_approval job, whose spec is by definition not archived).
    .select("id, workspace_id, kind, spec_slug, status, pending_actions, log_tail")
    .eq("status", "needs_approval")
    .limit(500);
  // SAFETY: never act on a FAILED read. A null/errored job query would otherwise look like "0 open jobs"
  // and the dismiss loop below would dismiss EVERY approval notification — one transient read wipes the
  // whole CEO inbox (observed 2026-06-24). On error, bail and leave the inbox untouched until the next tick.
  if (jobsError) {
    console.warn(`[approval-inbox] job read failed — skipping reconcile to protect the inbox: ${jobsError.message}`);
    // The stale-park auto-clear reads its OWN sources (park notifications + agent_jobs/specs/deploy_watches),
    // independent of this failed needs_approval read — so still run it (its own guard bails on its own error).
    let parksCleared = 0;
    try {
      parksCleared = await reconcileStaleParkCards(admin);
    } catch (e) {
      console.warn(`[approval-inbox] stale-park reconcile threw on bail path (continuing): ${e instanceof Error ? e.message : e}`);
    }
    return { created: 0, dismissed: 0, parksCleared };
  }
  const jobs = (jobsData ?? []) as ApprovalJobRow[];
  const openJobIds = new Set(jobs.map((j) => j.id));

  const { data: notifData } = await admin
    .from("dashboard_notifications")
    .select("id, workspace_id, metadata")
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("dismissed", false)
    .limit(2000);
  const notifs = (notifData ?? []) as { id: string; workspace_id: string; metadata: Record<string, unknown> | null }[];
  const emittedJobIds = new Set<string>();
  for (const n of notifs) {
    const jid = n.metadata?.["agent_job_id"];
    if (typeof jid === "string") emittedJobIds.add(jid);
  }

  let created = 0;
  // Per-workspace cache so a single sweep touching N jobs from M workspaces does ≤M Slack lookups,
  // not N. A workspace with `slack_ada_channel_id` unset short-circuits below — token is only
  // decrypted when a channel exists AND we'll actually post.
  const slackAdaCache = new Map<string, { channelId: string | null; token: string | null }>();
  for (const job of jobs) {
    if (emittedJobIds.has(job.id)) continue; // already surfaced — idempotent across re-parks
    // plan-approval-routes-by-goal-owner: a plan job's routing owner is its GOAL's owner (DB read), not the
    // planner's platform default. routingOwnerForJobAsync resolves it; every other kind stays sync-derivable.
    const ownerFn = await routingOwnerForJobAsync(admin, job);
    const row = buildApprovalNotification(job, chart, autonomy, ownerFn);
    // .select() so we know the new row's id — the routed-inbox Slack card (below) needs to embed it in
    // each button's `value`, and the chat.update path (Phase 2/4) needs it to find the message ts.
    const { data: inserted, error } = await admin
      .from("dashboard_notifications")
      .insert(row)
      .select("id")
      .maybeSingle();
    if (error || !inserted) continue;
    created++;
    await mirrorToAdaSlackInbox(admin, job, row, inserted.id as string, slackAdaCache);
  }

  let dismissed = 0;
  for (const n of notifs) {
    const jid = n.metadata?.["agent_job_id"];
    if (typeof jid === "string" && !openJobIds.has(jid)) {
      const { error } = await admin.from("dashboard_notifications").update({ dismissed: true }).eq("id", n.id);
      if (!error) {
        dismissed++;
        // ada-slack-routed-approvals Phase 2: when the dismissed notif had a Slack card posted in
        // #cto-ada, post a one-line outcome confirmation as a thread reply on that card so the
        // founder gets a closing signal in the same surface where they tapped (or, if the decision
        // came from the web inbox, where the card still sits). Best-effort.
        await postSlackDismissConfirmation(admin, n, jid, slackAdaCache);
      }
    }
  }

  // AUTO-CLEAR stale PARK cards (one-card-per-park): dismiss any director park escalation / system age
  // alarm whose underlying reason is gone. Separate from the needs_approval dismiss loop above (those
  // are routed Approval Requests keyed on agent_job_id; park cards key on job_id + escalation_kind).
  // Best-effort; never aborts the sweep.
  let parksCleared = 0;
  try {
    parksCleared = await reconcileStaleParkCards(admin);
  } catch (e) {
    console.warn(`[approval-inbox] stale-park reconcile threw (continuing): ${e instanceof Error ? e.message : e}`);
  }

  return { created, dismissed, parksCleared };
}

/**
 * Phase 4 (ada-slack-routed-approvals) — mirror a non-Slack-inbox approval decision back to the
 * #cto-ada Slack surface so the two surfaces never show stale state. Called from
 * `approveRoadmapAction` AFTER the job has been updated + the ledger entry recorded; the decision
 * path is unchanged. Best-effort: a Slack failure must never roll back the decision.
 *
 * Behavior forks on the original Slack surface (Phase 1 vs Phase 3):
 *   - **card** (default): `chat.update` the stored ts so the just-decided action's row reads
 *     "✅ Approved (in web inbox)" / "✕ Declined (in web inbox)"; remaining pending rows stay
 *     tappable. The card is rebuilt from the LIVE job state — same approach the Slack tap takes
 *     in `handleInboxDecision`, so a multi-action bundle stays consistent.
 *   - **chat-mode invitation** (`metadata.slack_chat_mode === true`): post a short Ada thread
 *     reply ("Decided in the web inbox — approved/declined. Anything to dig into?") so the
 *     conversation doesn't dangle.
 *
 * No-op when the notification has no Slack mirror (`slack_message_ts` absent — the non-CEO routed
 * case, or a workspace without `slack_ada_channel_id`). Skipped at the caller for in-Slack taps
 * (their handler updates the card locally without the "(in web inbox)" suffix).
 */
export async function mirrorWebDecisionToAdaSlack(
  admin: Admin,
  workspaceId: string,
  jobId: string,
  actionId: string,
  decision: "approve" | "decline",
): Promise<void> {
  try {
    const { data: notif } = await admin
      .from("dashboard_notifications")
      .select("id, title, body, metadata")
      .eq("workspace_id", workspaceId)
      .eq("type", APPROVAL_REQUEST_TYPE)
      .filter("metadata->>agent_job_id", "eq", jobId)
      .maybeSingle();
    if (!notif) return;
    const meta = (notif.metadata || {}) as Record<string, unknown>;
    const slackTs = typeof meta["slack_message_ts"] === "string" ? (meta["slack_message_ts"] as string) : null;
    if (!slackTs) return;

    const surface = await loadAdaSurface(admin, workspaceId, new Map());
    if (!surface.channelId || !surface.token) return;

    // Chat-mode (Phase 3): the Slack surface is an invitation thread, not a card. A thread reply
    // closes the loop without making us guess how to render an "approval card" for a multi-choice
    // or brain-touching ask that never had buttons in the first place.
    if (meta["slack_chat_mode"] === true) {
      const text = decision === "approve"
        ? "Decided in the web inbox — approved. Anything to dig into?"
        : "Decided in the web inbox — declined. Anything to dig into?";
      await postAsAda(surface.token, surface.channelId, [], text, { thread_ts: slackTs });
      return;
    }

    // Card surface — rebuild from the LIVE job state so a multi-action bundle keeps still-pending
    // rows tappable while the just-decided row flips to "(in web inbox)". Other previously-decided
    // rows keep their default label (we only mark THIS decision's row as web-inbox-decided).
    const { data: job } = await admin
      .from("agent_jobs")
      .select("pending_actions")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return;
    const actions = (job.pending_actions as PendingActionLike[] | null) ?? [];
    const cardActions: InboxCardAction[] = actions
      .filter((a): a is PendingActionLike & { id: string } => !!a.id)
      .map((a) => ({
        id: a.id as string,
        summary: actionLabel(a),
        status: a.status === "approved" ? "approved" : a.status === "declined" ? "declined" : "pending",
        decidedInWebInbox: a.id === actionId && (a.status === "approved" || a.status === "declined"),
      }));
    const card = buildInboxApprovalCard({
      notificationId: notif.id as string,
      title: (notif.title as string | null) ?? "",
      body: (notif.body as string | null) ?? "",
      actions: cardActions,
    });
    await updateMessage(surface.token, surface.channelId, slackTs, card.blocks, card.text);
  } catch (e) {
    console.warn(`[approval-inbox] mirrorWebDecisionToAdaSlack failed (best-effort, ignoring): ${(e as Error).message}`);
  }
}

/**
 * Post the closing thread reply on a Slack #cto-ada inbox card whose underlying job has left
 * `needs_approval` (ada-slack-routed-approvals Phase 2). Reads the job's pending_actions to decide
 * the outcome — "Approved — resuming the build." (with PR # when one already exists) vs
 * "Declined — build returned to me." (any action declined ⇒ ALL-OR-NOTHING decline). No-op when
 * the notif never carried a Slack card (`slack_message_ts` absent — the non-CEO routed case, or a
 * workspace without `slack_ada_channel_id`). Best-effort: a Slack failure must never block the
 * dismiss sweep, since the notification is already dismissed by the time we post here.
 */
async function postSlackDismissConfirmation(
  admin: Admin,
  notif: { workspace_id: string; metadata: Record<string, unknown> | null },
  jobId: string,
  cache: AdaSurfaceCache,
): Promise<void> {
  const meta = notif.metadata || {};
  const slackTs = typeof meta["slack_message_ts"] === "string" ? (meta["slack_message_ts"] as string) : null;
  if (!slackTs) return;

  const { data: job } = await admin
    .from("agent_jobs")
    .select("pending_actions, pr_number")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return;
  const actions = (job.pending_actions as PendingActionLike[] | null) ?? [];
  const declined = actions.some((a) => a.status === "declined");
  const prNumber = typeof job.pr_number === "number" ? job.pr_number : null;
  const text = declined
    ? "✕ Declined — build returned to me."
    : prNumber
      ? `✅ Approved — PR #${prNumber} resumed.`
      : "✅ Approved — resuming the build.";

  const surface = await loadAdaSurface(admin, notif.workspace_id, cache);
  if (!surface.channelId || !surface.token) return;
  await postAsAda(surface.token, surface.channelId, [], text, { thread_ts: slackTs });
}
