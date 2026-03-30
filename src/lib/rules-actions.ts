import { createAdminClient } from "@/lib/supabase/admin";
import { sendTicketReply } from "@/lib/email";
import type { RuleAction, RuleContext } from "@/lib/rules-engine";

type Admin = ReturnType<typeof createAdminClient>;

export async function executeActions(
  workspaceId: string,
  actions: RuleAction[],
  context: RuleContext,
): Promise<void> {
  const admin = createAdminClient();

  for (const action of actions) {
    try {
      switch (action.type) {
        case "add_tag":
          await addTag(admin, workspaceId, action.params, context);
          break;
        case "remove_tag":
          await removeTag(admin, action.params, context);
          break;
        case "set_status":
          await setStatus(admin, action.params, context);
          break;
        case "assign":
          await assignTicket(admin, action.params, context);
          break;
        case "auto_reply":
          await autoReply(admin, workspaceId, action.params, context);
          break;
        case "internal_note":
          await internalNote(admin, action.params, context);
          break;
        case "update_customer":
          await updateCustomer(admin, action.params, context);
          break;
        case "appstle_action":
          await appstleAction(workspaceId, action.params, context);
          break;
        default:
          console.warn(`Unknown rule action type: ${action.type}`);
      }
    } catch (err) {
      console.error(`Rule action "${action.type}" error:`, err);
    }
  }
}

// ── Individual action executors ──

async function addTag(admin: Admin, workspaceId: string, params: Record<string, unknown>, context: RuleContext) {
  const tag = params.tag as string;
  if (!tag) return;

  const ticketId = context.ticket?.id as string | undefined;
  if (ticketId) {
    // Fetch current tags, add new one if not present
    const { data: ticket } = await admin.from("tickets").select("tags").eq("id", ticketId).single();
    const tags: string[] = (ticket?.tags as string[]) || [];
    if (!tags.includes(tag)) {
      tags.push(tag);
      await admin.from("tickets").update({ tags, updated_at: new Date().toISOString() }).eq("id", ticketId);
      // Update context so subsequent rules see the new tag
      if (context.ticket) context.ticket.tags = tags;
    }
    return;
  }

  // If no ticket, try customer tags
  const customerId = context.customer?.id as string | undefined;
  if (customerId) {
    const { data: customer } = await admin.from("customers").select("tags").eq("id", customerId).single();
    const tags: string[] = (customer?.tags as string[]) || [];
    if (!tags.includes(tag)) {
      tags.push(tag);
      await admin.from("customers").update({ tags, updated_at: new Date().toISOString() }).eq("id", customerId);
      if (context.customer) context.customer.tags = tags;
    }
  }
}

async function removeTag(admin: Admin, params: Record<string, unknown>, context: RuleContext) {
  const tag = params.tag as string;
  if (!tag) return;

  const ticketId = context.ticket?.id as string | undefined;
  if (ticketId) {
    const { data: ticket } = await admin.from("tickets").select("tags").eq("id", ticketId).single();
    const tags: string[] = ((ticket?.tags as string[]) || []).filter(t => t !== tag);
    await admin.from("tickets").update({ tags, updated_at: new Date().toISOString() }).eq("id", ticketId);
    if (context.ticket) context.ticket.tags = tags;
    return;
  }

  const customerId = context.customer?.id as string | undefined;
  if (customerId) {
    const { data: customer } = await admin.from("customers").select("tags").eq("id", customerId).single();
    const tags: string[] = ((customer?.tags as string[]) || []).filter(t => t !== tag);
    await admin.from("customers").update({ tags, updated_at: new Date().toISOString() }).eq("id", customerId);
    if (context.customer) context.customer.tags = tags;
  }
}

async function setStatus(admin: Admin, params: Record<string, unknown>, context: RuleContext) {
  const ticketId = context.ticket?.id as string | undefined;
  const status = params.status as string;
  if (!ticketId || !status) return;

  const updates: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "closed") {
    updates.resolved_at = new Date().toISOString();
    updates.closed_at = new Date().toISOString();
  }
  if (status === "open") updates.closed_at = null;
  await admin.from("tickets").update(updates).eq("id", ticketId);
  if (context.ticket) context.ticket.status = status;
}

async function assignTicket(admin: Admin, params: Record<string, unknown>, context: RuleContext) {
  const ticketId = context.ticket?.id as string | undefined;
  if (!ticketId) return;

  const userId = (params.user_id as string) || null;
  await admin.from("tickets").update({ assigned_to: userId, updated_at: new Date().toISOString() }).eq("id", ticketId);
  if (context.ticket) context.ticket.assigned_to = userId;
}

async function autoReply(admin: Admin, workspaceId: string, params: Record<string, unknown>, context: RuleContext) {
  const ticketId = context.ticket?.id as string | undefined;
  const template = params.template as string;
  if (!ticketId || !template) return;

  // Resolve template variables
  const body = resolveTemplate(template, context);

  // Insert message
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "external",
    author_type: "system",
    body,
  });

  // Send email if ticket has customer email
  const customerEmail = context.customer?.email as string | undefined;
  const ticketSubject = context.ticket?.subject as string || "Support";
  const emailMessageId = context.ticket?.email_message_id as string | null;

  if (customerEmail) {
    // Get workspace name
    const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();
    await sendTicketReply({
      workspaceId,
      toEmail: customerEmail,
      subject: ticketSubject,
      body,
      inReplyTo: emailMessageId || null,
      agentName: "Support",
      workspaceName: ws?.name || "Support",
    });
  }

  // Update ticket status to pending (agent/system replied)
  await admin.from("tickets").update({
    status: "pending",
    updated_at: new Date().toISOString(),
  }).eq("id", ticketId);
}

async function internalNote(admin: Admin, params: Record<string, unknown>, context: RuleContext) {
  const ticketId = context.ticket?.id as string | undefined;
  const body = params.body as string;
  if (!ticketId || !body) return;

  const workspaceId = context.ticket?.workspace_id as string;
  const resolvedBody = resolveTemplate(body, context);

  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: resolvedBody,
  });
}

async function updateCustomer(admin: Admin, params: Record<string, unknown>, context: RuleContext) {
  const customerId = context.customer?.id as string | undefined;
  if (!customerId) return;

  const field = params.field as string;
  const value = params.value;
  if (!field) return;

  await admin.from("customers").update({
    [field]: value,
    updated_at: new Date().toISOString(),
  }).eq("id", customerId);

  if (context.customer) context.customer[field] = value;
}

async function appstleAction(workspaceId: string, params: Record<string, unknown>, context: RuleContext) {
  const action = params.action as string; // "pause", "cancel", "resume"
  const contractId = context.subscription?.shopify_contract_id as string | undefined;
  if (!action || !contractId) return;

  // Dynamic import to avoid circular deps
  const { appstleSubscriptionAction } = await import("@/lib/appstle");
  await appstleSubscriptionAction(workspaceId, contractId, action as "pause" | "cancel" | "resume");
}

// ── Template resolution ──

function resolveTemplate(template: string, context: RuleContext): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
    const parts = path.split(".");
    let current: unknown = context;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return "";
      current = (current as Record<string, unknown>)[part];
    }
    return current != null ? String(current) : "";
  });
}
