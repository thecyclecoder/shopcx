/**
 * Agent To-Do system — execution of customer-facing todos.
 *
 * Used by the Inngest event worker `agent-todo-execute` (Phase 4). Handles only
 * customer-facing action types (customer_reply, customer_action, ticket_close);
 * system-level actions are the Claude Code Routine's territory.
 *
 * The flow per approved customer-facing todo:
 *   1. driftCheck() — re-fetch live ticket state, compare to pre_exec_context.
 *      If a new inbound message landed since approval, supersede silently.
 *   2. executeCustomerTodo() — dispatch by action_type.
 *   3. maybeAutoCloseGroup() — when the last customer-facing todo in the group
 *      executes, close + unescalate the ticket and drop a system note.
 *
 * See docs/brain/lifecycles/agent-todo-system.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { sendTicketReply } from "@/lib/email";
import {
  directActionHandlers,
  type ActionContext,
  type ActionParams,
} from "@/lib/action-executor";
import type { AgentTodo, ExecutionResult } from "./types";
import { CUSTOMER_FACING_ACTION_TYPES } from "./constants";

type Admin = ReturnType<typeof createAdminClient>;

/** Latest inbound (customer) message id on a ticket, for drift detection. */
async function latestInboundMessageId(admin: Admin, ticketId: string): Promise<string | null> {
  const { data } = await admin
    .from("ticket_messages")
    .select("id")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

export interface DriftResult {
  drifted: boolean;
  reason?: string;
}

/**
 * Drift check — has the customer replied since the todo was proposed/approved?
 * If so the proposed reply/action may be stale; we supersede instead of acting.
 */
export async function driftCheck(admin: Admin, todo: AgentTodo): Promise<DriftResult> {
  if (!todo.source_ticket_id) return { drifted: false };
  const snapshot = todo.pre_exec_context?.latest_inbound_message_id;
  // No snapshot captured → nothing to compare; allow execution.
  if (snapshot === undefined) return { drifted: false };
  const live = await latestInboundMessageId(admin, todo.source_ticket_id);
  if (live !== snapshot) {
    return {
      drifted: true,
      reason: `Customer replied after proposal (snapshot=${snapshot ?? "none"}, live=${live ?? "none"}).`,
    };
  }
  return { drifted: false };
}

const toHtml = (t: string) =>
  t
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

const sysNote = (admin: Admin, tid: string, msg: string) =>
  admin.from("ticket_messages").insert({
    ticket_id: tid,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: msg,
  });

/** Whether the workspace is in sandbox/test mode (don't hit real send/APIs). */
async function isSandbox(admin: Admin, wsId: string): Promise<boolean> {
  const { data } = await admin.from("workspaces").select("sandbox_mode").eq("id", wsId).single();
  return data?.sandbox_mode === true;
}

/**
 * Deliver an approved customer_reply on the ticket's channel. Mirrors the
 * `send()` helper in unified-ticket-handler: insert the outbound message, then
 * deliver via email (or chat→email fallback when the chat customer is idle).
 */
async function executeCustomerReply(admin: Admin, todo: AgentTodo): Promise<ExecutionResult> {
  const tid = todo.source_ticket_id;
  if (!tid) return { ok: false, error: "customer_reply has no source_ticket_id" };
  const payload = todo.payload as { body_html?: string; response_message?: string };
  // Fallback: some todos stored the reply under `response_message` (the orchestrator's key) instead of
  // body_html — accept it so the reply still sends instead of erroring (plain text → <p> paragraphs).
  const raw = (payload.body_html || "").trim() || (payload.response_message || "").trim();
  const html = /<[a-z][\s\S]*>/i.test(raw) ? raw : raw.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  if (!html) return { ok: false, error: "customer_reply payload missing body_html/response_message" };

  const { data: t } = await admin
    .from("tickets")
    .select("channel, subject, email_message_id, customer_id")
    .eq("id", tid)
    .single();
  if (!t) return { ok: false, error: "ticket not found" };

  const sandbox = await isSandbox(admin, todo.workspace_id);
  if (sandbox) {
    await admin.from("ticket_messages").insert({
      ticket_id: tid,
      direction: "outbound",
      visibility: "internal",
      author_type: "ai",
      body: `[AI Draft — sandbox] ${html}`,
    });
    return { ok: true, message_id: null as unknown as string, sandbox: true };
  }

  // Insert the outbound message (visible immediately).
  await admin.from("ticket_messages").insert({
    ticket_id: tid,
    direction: "outbound",
    visibility: "external",
    author_type: "ai",
    body: html,
    sent_at: new Date().toISOString(),
  });

  const { addTicketTag } = await import("@/lib/ticket-tags");
  await addTicketTag(tid, "ai");

  const ch = t.channel;
  let messageId: string | undefined;

  // Resolve the effective delivery channel (chat→email when idle).
  let deliverEmail = ch === "email";
  if (ch === "chat") {
    const { getDeliveryChannel } = await import("@/lib/delivery-channel");
    deliverEmail = (await getDeliveryChannel(tid, ch)) === "email";
  }

  if (deliverEmail && t.customer_id) {
    const { data: cust } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
    if (cust?.email) {
      const { data: ws } = await admin.from("workspaces").select("name").eq("id", todo.workspace_id).single();
      const res = await sendTicketReply({
        workspaceId: todo.workspace_id,
        toEmail: cust.email,
        subject: `Re: ${t.subject || "Your request"}`,
        body: html,
        inReplyTo: t.email_message_id || null,
        agentName: "Support",
        workspaceName: ws?.name || "",
      });
      if (res.error) return { ok: false, error: `email send failed: ${res.error}` };
      messageId = res.messageId;
      if (messageId) {
        await admin
          .from("ticket_messages")
          .update({
            resend_email_id: messageId,
            email_status: "sent",
            email_message_id: `<${messageId}@resend.dev>`,
          })
          .eq("ticket_id", tid)
          .eq("direction", "outbound")
          .is("resend_email_id", null)
          .order("created_at", { ascending: false })
          .limit(1);
        // For a chat ticket newly delivered via email, persist the message id
        // for threading so customer replies land back on this ticket.
        if (ch === "chat") {
          await admin.from("tickets").update({ email_message_id: `<${messageId}@resend.dev>` }).eq("id", tid);
        }
      }
    }
  }

  return { ok: true, message_id: messageId };
}

/**
 * Execute an approved customer_action by dispatching each action through the
 * orchestrator's directActionHandlers registry (remove_item, partial_refund,
 * create_return, pause_timed, redeem_points, …).
 */
async function executeCustomerAction(admin: Admin, todo: AgentTodo): Promise<ExecutionResult> {
  const tid = todo.source_ticket_id;
  if (!tid) return { ok: false, error: "customer_action has no source_ticket_id" };
  const payload = todo.payload as { actions?: ActionParams[]; kind?: string; params?: Record<string, unknown> };

  // Accept either { actions: [...] } or a single { kind, params } shape.
  let actions: ActionParams[] = [];
  if (Array.isArray(payload.actions)) actions = payload.actions;
  else if (payload.kind) actions = [{ type: payload.kind, ...(payload.params || {}) } as ActionParams];
  if (!actions.length) return { ok: false, error: "customer_action payload has no actions" };

  const { data: t } = await admin.from("tickets").select("channel, customer_id").eq("id", tid).single();
  if (!t?.customer_id) return { ok: false, error: "ticket has no customer_id" };

  const sandbox = await isSandbox(admin, todo.workspace_id);
  const ctx: ActionContext = {
    admin,
    workspaceId: todo.workspace_id,
    ticketId: tid,
    customerId: t.customer_id,
    channel: t.channel,
    sandbox,
  };

  const { withActionContext } = await import("@/lib/appstle-call-log");
  const results: Array<{ type: string; success: boolean; error?: string; summary?: string }> = [];

  for (const raw of actions) {
    const action = { ...raw };
    // Resolve internal UUID contract_id → Shopify contract id (mirrors executeActionsInline).
    if (action.contract_id && action.contract_id.includes("-")) {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("shopify_contract_id")
        .eq("id", action.contract_id)
        .maybeSingle();
      if (sub?.shopify_contract_id) action.contract_id = sub.shopify_contract_id;
    }
    const handler = directActionHandlers[action.type];
    if (!handler) {
      // Improve-only account-repair actions (reassign_ticket_customer /
      // send_magic_link / link_customer_accounts) deliberately live OUTSIDE
      // directActionHandlers (the Sonnet orchestrator must never trigger them).
      // The escalation-triage solver proposes them for the auto-detected
      // duplicate-account pattern, so route them through the same shared
      // dispatcher the Improve tab uses — one code path. link_customer_accounts
      // enforces the empty-shell heuristic inside the dispatcher.
      const { IMPROVE_ONLY_ACTION_TYPES, runImproveOnlyAccountAction } = await import("@/lib/improve-actions");
      if ((IMPROVE_ONLY_ACTION_TYPES as readonly string[]).includes(action.type)) {
        const r = await runImproveOnlyAccountAction(admin, ctx.workspaceId, ctx.ticketId, action);
        results.push({ type: action.type, success: r.success, summary: r.success ? r.message : undefined, error: r.success ? undefined : r.message });
        await sysNote(admin, tid, r.success ? `[System] Action completed: ${r.message}` : `[System] Action failed: ${action.type} — ${r.message}`);
        continue;
      }
      results.push({ type: action.type, success: false, error: `Unknown action type: ${action.type}` });
      continue;
    }
    try {
      const r = await withActionContext(
        { workspaceId: ctx.workspaceId, ticketId: ctx.ticketId, customerId: ctx.customerId, actionType: action.type },
        () => handler(ctx, action),
      );
      results.push({ type: action.type, success: r.success, error: r.error, summary: r.summary });
      await sysNote(admin, tid, r.success ? `[System] Action completed: ${r.summary || action.type}` : `[System] Action failed: ${action.type} — ${r.error}`);
    } catch (err) {
      const msg = errText(err);
      results.push({ type: action.type, success: false, error: msg });
      await sysNote(admin, tid, `[System] Action errored: ${action.type} — ${msg}`);
    }
  }

  const allOk = results.every((r) => r.success);
  return { ok: allOk, results, error: allOk ? undefined : "one or more actions failed" };
}

/** Close a ticket for a false-positive escalation (no customer touch needed). */
async function executeTicketClose(admin: Admin, todo: AgentTodo): Promise<ExecutionResult> {
  const tid = todo.source_ticket_id;
  if (!tid) return { ok: false, error: "ticket_close has no source_ticket_id" };
  const now = new Date().toISOString();
  await admin
    .from("tickets")
    .update({ status: "closed", escalated_at: null, escalated_to: null, escalation_reason: null, assigned_to: null, closed_at: now, updated_at: now })
    .eq("id", tid);
  await sysNote(admin, tid, "[System] Closed via To-Do system (false-positive escalation).");
  return { ok: true };
}

/**
 * Apply an approved ticket_analysis_rescore: correct the latest analysis with the box's score.
 * Moved here from the retired Claude Code Routine (box-escalation-triage) so the Inngest event worker
 * can execute it on approval — it's a single ticket_analyses update, no repo/PR needed.
 */
async function executeAnalysisRescore(admin: Admin, todo: AgentTodo): Promise<ExecutionResult> {
  const p = todo.payload as { ticket_analysis_id?: string; score?: number; summary?: string; issues?: unknown };
  if (!p.ticket_analysis_id) return { ok: false, error: "missing ticket_analysis_id" };
  // Route through the ticket-analyses SDK (Phase 2 of ticket-analyzer-becomes-box-agent-under-
  // june). applyAgentRescore is compare-and-set against (id, workspace_id) so a mismatched-
  // workspace id can never overwrite another workspace's row. `todo.workspace_id` is the
  // authenticated approver's scope.
  const { applyAgentRescore } = await import("@/lib/ticket-analyses-table");
  const r = await applyAgentRescore({
    analysisId: p.ticket_analysis_id,
    workspaceId: todo.workspace_id,
    score: p.score,
    summary: p.summary,
    issues: p.issues,
    source: "escalation-triage:approved",
  });
  if (!r.ok) return { ok: false, error: r.error ?? "applyAgentRescore failed" };
  return { ok: true, row_id: p.ticket_analysis_id };
}

/** Dispatch a single approved, Inngest-executable todo (customer-facing actions + the re-score). */
export async function executeCustomerTodo(admin: Admin, todo: AgentTodo): Promise<ExecutionResult> {
  switch (todo.action_type) {
    case "customer_reply":
      return executeCustomerReply(admin, todo);
    case "customer_action":
      return executeCustomerAction(admin, todo);
    case "ticket_close":
      return executeTicketClose(admin, todo);
    case "ticket_analysis_rescore":
      return executeAnalysisRescore(admin, todo);
    default:
      return { ok: false, error: `executeCustomerTodo cannot handle ${todo.action_type}` };
  }
}

/**
 * Auto-closure (Phase 1 step 3): when every customer-facing todo in the group
 * is executed, close + unescalate + unassign the source ticket and add a note.
 * System-level todos (sonnet_prompt_*, brain/code) do NOT block closure.
 */
export async function maybeAutoCloseGroup(admin: Admin, todo: AgentTodo): Promise<boolean> {
  const tid = todo.source_ticket_id;
  if (!tid) return false;

  const { data: groupTodos } = await admin
    .from("agent_todos")
    .select("action_type, status")
    .eq("group_id", todo.group_id);
  if (!groupTodos) return false;

  const customerFacing = groupTodos.filter((g) =>
    CUSTOMER_FACING_ACTION_TYPES.includes(g.action_type as AgentTodo["action_type"]),
  );
  if (!customerFacing.length) return false;

  // ticket_close on its own closes the ticket via its own handler; here we
  // care about the reply/action group all reaching `executed`.
  const allExecuted = customerFacing.every((g) => g.status === "executed");
  if (!allExecuted) return false;

  // ticket_close already closed the ticket; skip the duplicate note.
  const onlyClose = customerFacing.every((g) => g.action_type === "ticket_close");
  if (onlyClose) return true;

  const now = new Date().toISOString();
  await admin
    .from("tickets")
    .update({ status: "closed", escalated_at: null, escalated_to: null, escalation_reason: null, assigned_to: null, closed_at: now, updated_at: now })
    .eq("id", tid);

  const approver = todo.approval_role ? `${todo.approval_role}` : "approver";
  await sysNote(
    admin,
    tid,
    `[System] Resolved via To-Do system. Approved by ${approver} at ${now}.`,
  );
  return true;
}

/**
 * Snapshot the current ticket state for drift detection. Called by the
 * reasoning pass when proposing customer-facing todos.
 */
export async function buildPreExecContext(
  admin: Admin,
  ticketId: string,
): Promise<{ latest_inbound_message_id: string | null; ticket_status: string | null }> {
  const [{ data: t }, inbound] = await Promise.all([
    admin.from("tickets").select("status").eq("id", ticketId).single(),
    latestInboundMessageId(admin, ticketId),
  ]);
  return { latest_inbound_message_id: inbound, ticket_status: t?.status ?? null };
}
