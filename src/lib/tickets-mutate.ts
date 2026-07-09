/**
 * tickets-mutate — the typed write surface for a support ticket. Two clearly-separated layers:
 *
 *  (A) TICKET-ROW STATE (deterministic, non-AI) — close / reopen / status / escalate / assign / tag /
 *      playbook-arm / do-not-reply. These mutate the `tickets` row itself and are what deterministic
 *      flows (outreach auto-close, sol-closes-on-resolving-reply) and hand-fixes need. No orchestrator,
 *      no model, no customer message — just the row.
 *
 *  (B) COMMERCE / JOURNEYS / WORKFLOWS (AI-decided customer actions) — NOT re-implemented here. Every
 *      subscription/order/loyalty/crisis/customer mutation, plus journeys, playbooks, workflows, macros
 *      and escalate, already lives behind ONE executor: `executeSonnetDecision` in [[action-executor]]
 *      (39 `directActionHandlers` + 8 `action_type`s). `runTicketDecision` below is the single front
 *      door onto it — the SAME path the Improve tab uses ([[improve-plan-executor]]) — so a hand-fix or
 *      Sol's cheap-execution reaches all of it with zero drift + the selective-clarify gate + the
 *      resolution-events ledger for free. Journeys and Workflows are `launchJourney` / `runWorkflow`
 *      thin wrappers that build a `SonnetDecision` and delegate here — never a parallel code path.
 *
 * Read side: [[tickets-read]]. Threaded customer replies: [[tickets-reply]] (`sendThreadedReply`).
 * Why layer (B) is not duplicated: CLAUDE.md North star + "identical ticket messages" — one customer-
 * action code path. Catalog of everything reachable: [[../orchestrator-tools]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { addTicketTag } from "@/lib/ticket-tags";
import type { SonnetDecision } from "@/lib/sonnet-orchestrator-v2";

type Admin = ReturnType<typeof createAdminClient>;

// A frozen "now" per call keeps updated_at/closed_at/escalated_at coherent within one mutation.
const nowIso = () => new Date().toISOString();

export type TicketStatus = "open" | "pending" | "closed" | "archived";

// ─────────────────────────────────────────────────────────────────────────────
// (A) TICKET-ROW STATE — deterministic, no model, no customer message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Close a ticket. Mirrors the handler's canonical close: status=closed + closed_at stamped + any
 * escalation cleared (a closed ticket is not "waiting on an agent"). Idempotent-safe to re-run.
 */
export async function closeTicket(
  admin: Admin,
  ticketId: string,
  opts: { reason?: string } = {},
): Promise<void> {
  const ts = nowIso();
  await admin
    .from("tickets")
    .update({
      status: "closed",
      closed_at: ts,
      escalated_to: null,
      escalated_at: null,
      escalation_reason: opts.reason ?? null,
      updated_at: ts,
    })
    .eq("id", ticketId);
}

/**
 * Reopen a ticket (the next-inbound-reopens shape): status=open, clear closed_at, drop escalation +
 * assignment so it re-enters the normal handling flow.
 */
export async function reopenTicket(admin: Admin, ticketId: string): Promise<void> {
  const ts = nowIso();
  await admin
    .from("tickets")
    .update({
      status: "open",
      closed_at: null,
      escalated_to: null,
      escalated_at: null,
      assigned_to: null,
      updated_at: ts,
    })
    .eq("id", ticketId);
}

/** Set an explicit ticket status. `closed` stamps closed_at; any non-closed status clears it. */
export async function setTicketStatus(admin: Admin, ticketId: string, status: TicketStatus): Promise<void> {
  const ts = nowIso();
  const patch: Record<string, unknown> = { status, updated_at: ts };
  patch.closed_at = status === "closed" ? ts : null;
  await admin.from("tickets").update(patch).eq("id", ticketId);
}

/**
 * Escalate to a human agent: stamp escalated_to/at/reason and (optionally) assign. Leaves the ticket
 * open — an escalation is a hand-off, not a close.
 */
export async function escalateTicket(
  admin: Admin,
  ticketId: string,
  opts: { toUserId?: string | null; reason: string },
): Promise<void> {
  const ts = nowIso();
  const patch: Record<string, unknown> = {
    status: "open",
    escalated_to: opts.toUserId ?? null,
    escalated_at: ts,
    escalation_reason: opts.reason,
    updated_at: ts,
  };
  if (opts.toUserId) patch.assigned_to = opts.toUserId;
  await admin.from("tickets").update(patch).eq("id", ticketId);
}

/** Assign (or unassign, with null) a ticket to a workspace member. */
export async function assignTicket(admin: Admin, ticketId: string, userId: string | null): Promise<void> {
  await admin.from("tickets").update({ assigned_to: userId, updated_at: nowIso() }).eq("id", ticketId);
}

/** Add a tag (idempotent — composes [[ticket-tags]] `addTicketTag`). */
export async function addTag(_admin: Admin, ticketId: string, tag: string): Promise<void> {
  await addTicketTag(ticketId, tag);
}

/** Remove a tag if present (idempotent). */
export async function removeTag(admin: Admin, ticketId: string, tag: string): Promise<void> {
  const { data } = await admin.from("tickets").select("tags").eq("id", ticketId).single();
  if (!data) return;
  const tags = ((data.tags as string[]) || []).filter((t) => t !== tag);
  await admin.from("tickets").update({ tags, updated_at: nowIso() }).eq("id", ticketId);
}

/** Arm a playbook on a ticket (start it at `step`, seeding optional context). */
export async function armPlaybook(
  admin: Admin,
  ticketId: string,
  opts: { playbookId: string; step?: number; context?: Record<string, unknown> },
): Promise<void> {
  await admin
    .from("tickets")
    .update({
      active_playbook_id: opts.playbookId,
      playbook_step: opts.step ?? 0,
      playbook_context: opts.context ?? {},
      updated_at: nowIso(),
    })
    .eq("id", ticketId);
}

/** Advance the current playbook to an explicit step. */
export async function advancePlaybookStep(admin: Admin, ticketId: string, step: number): Promise<void> {
  await admin.from("tickets").update({ playbook_step: step, updated_at: nowIso() }).eq("id", ticketId);
}

/** Clear the active playbook (matches the handler's playbook-complete reset). */
export async function clearPlaybook(admin: Admin, ticketId: string): Promise<void> {
  await admin
    .from("tickets")
    .update({ active_playbook_id: null, playbook_step: 0, playbook_exceptions_used: 0, updated_at: nowIso() })
    .eq("id", ticketId);
}

/** Toggle do-not-reply (suppress automated replies on this ticket). */
export async function setDoNotReply(admin: Admin, ticketId: string, value: boolean): Promise<void> {
  await admin.from("tickets").update({ do_not_reply: value, updated_at: nowIso() }).eq("id", ticketId);
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) COMMERCE / JOURNEYS / WORKFLOWS — the ONE executor front door
// ─────────────────────────────────────────────────────────────────────────────

export interface RunTicketDecisionResult {
  messageSent: boolean;
  escalated: boolean;
  closed: boolean;
  statusManaged: boolean;
}

/**
 * Execute a full `SonnetDecision` against a ticket through the production executor
 * (`executeSonnetDecision`) — the SAME path the orchestrator and Improve tab use. This is how ALL of
 * commerce (39 direct-action handlers), journeys, playbooks, workflows, macros, and escalate are
 * reached from a hand-fix or Sol's cheap-execution — one path, no drift, with the selective-clarify
 * gate + resolution-events ledger applied. Resolves customer + channel from the ticket, wires the
 * portal-aware delivery sink, and logs an audit note (North star: the tool surfaces its reasoning).
 */
export async function runTicketDecision(
  admin: Admin,
  args: { workspaceId: string; ticketId: string; decision: SonnetDecision; sandbox?: boolean; auditPrefix?: string },
): Promise<RunTicketDecisionResult> {
  const { workspaceId, ticketId, decision } = args;
  const { executeSonnetDecision } = await import("@/lib/action-executor");
  const { deliverTicketMessage } = await import("@/lib/ticket-delivery");

  const { data: t } = await admin.from("tickets").select("customer_id, channel").eq("id", ticketId).single();
  if (!t?.customer_id) throw new Error(`runTicketDecision: ticket ${ticketId} has no customer`);
  let sandbox = args.sandbox;
  if (sandbox === undefined) {
    const { data: ws } = await admin.from("workspaces").select("sandbox_mode").eq("id", workspaceId).single();
    sandbox = ws?.sandbox_mode === true;
  }
  const channel = (t.channel as string | null) || "email";

  const ctx = { admin, workspaceId, ticketId, customerId: t.customer_id as string, channel, sandbox };
  const send = async (msg: string, sb: boolean) => {
    await deliverTicketMessage(admin, workspaceId, ticketId, channel, msg, sb);
  };
  const sysNote = async (msg: string) => {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system", body: msg,
    });
  };

  await sysNote(
    `${args.auditPrefix ?? "[tickets-mutate]"} Running ${decision.action_type}` +
      `${decision.handler_name ? ` "${decision.handler_name}"` : ""}. Reasoning: ${decision.reasoning || "(none)"}`,
  );
  return executeSonnetDecision(ctx, decision, null, send, sysNote);
}

/**
 * Launch a journey on a ticket — thin wrapper over `runTicketDecision` (delegates to the same executor;
 * NOT a parallel journey launcher). Identify by journey name OR trigger_intent (handler_name), matching
 * the orchestrator's `action_type: "journey"` contract.
 *
 * DELIVERY CONTRACT (see [[journey-delivery]] launchJourneyForTicket): a journey is ALWAYS delivered as a
 * clickable CTA — Email/Help-Center render Sol's `leadIn` copy + a styled **button** carrying a fresh
 * magic link; Chat renders a CTA link bubble; SMS/DM degrade to a tappable URL (a text channel can't
 * render a button). The link is minted at send time and pulls live data on every click.
 *
 * `leadIn` is Sol's crafted lead-in message — the sentence(s) that introduce the button ("Happy to help
 * you cancel — tap below to review your options."). It maps to `decision.response_message`, which
 * handleJourney feeds to the journey launcher as `leadIn`. ALWAYS pass it — a journey with no lead-in
 * ships a bare button with no context. (`ctaText` — the button label — is honored by handleJourney only
 * once it prefers a decision-supplied value; today it defaults to the journey name. Carried here so
 * callers are forward-compatible.)
 *
 * TARGETING — journeys are CODE-DRIVEN, not snapshot-driven: Sol configures no snapshot; the journey
 * rebuilds from LIVE data at click time. Her only targeting input is an OPTIONAL `subscriptionId` HINT —
 * when she knows which sub the customer means, passing it skips the journey's own picker step; when she
 * doesn't, the journey picks at click time (robust either way). NB: `subscriptionId` is a hint only —
 * NEVER pass it for the cancel journey (handleJourney excludes cancel from pre-binding on purpose:
 * mis-bind once cancelled the wrong sub, 178ae5a7 — the cancel journey owns its picker). There is NO
 * order_id input path today, so ORDER-scoped journeys (Confirm Shipping Address, Missing Items) must
 * self-target — do not assume Sol can pre-bind an order. (subscriptionId is carried here for forward-
 * compat; handleJourney currently resolves it by sniffing `actions[].contract_id` — the hotfix moves it
 * to an explicit `plan.journey_subscription_id` field this maps onto.)
 */
export async function launchJourney(
  admin: Admin,
  args: {
    workspaceId: string;
    ticketId: string;
    journey: string;
    leadIn: string;
    ctaText?: string;
    /** OPTIONAL hint — the sub the customer means, to skip the journey's picker. Never set for cancel. */
    subscriptionId?: string;
    /** OPTIONAL hint — the internal order UUID an order-scoped journey (Confirm Shipping Address,
     * Missing Items) should target, so it skips its most-recent-order heuristic. */
    orderId?: string;
    reasoning?: string;
    sandbox?: boolean;
  },
): Promise<RunTicketDecisionResult> {
  if (!args.leadIn || !args.leadIn.trim()) {
    throw new Error("launchJourney: leadIn is required — a journey must ship with Sol's crafted lead-in copy, never a bare button");
  }
  const decision: SonnetDecision = {
    reasoning: args.reasoning ?? `Launch journey ${args.journey}`,
    action_type: "journey",
    handler_name: args.journey,
    response_message: args.leadIn,
  };
  return runTicketDecision(admin, { workspaceId: args.workspaceId, ticketId: args.ticketId, decision, sandbox: args.sandbox });
}

/**
 * Run a workflow on a ticket — thin wrapper over `runTicketDecision`. Identify by workflow name /
 * trigger_tag / template (handler_name), matching the orchestrator's `action_type: "workflow"` contract.
 * The workflow executor manages the ticket's final status itself (e.g. account_login closes, return_to_sender
 * stays open) — reflected in the returned `statusManaged`.
 */
export async function runWorkflow(
  admin: Admin,
  args: { workspaceId: string; ticketId: string; workflow: string; reasoning?: string; sandbox?: boolean },
): Promise<RunTicketDecisionResult> {
  const decision: SonnetDecision = {
    reasoning: args.reasoning ?? `Run workflow ${args.workflow}`,
    action_type: "workflow",
    handler_name: args.workflow,
  };
  return runTicketDecision(admin, { workspaceId: args.workspaceId, ticketId: args.ticketId, decision, sandbox: args.sandbox });
}
