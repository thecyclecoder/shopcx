// AI escalation handler
// Routes escalated tickets to the right person with context

import { createAdminClient } from "@/lib/supabase/admin";
import { sendTicketReply } from "@/lib/email";
import { dispatchSlackNotification } from "@/lib/slack-notify";

export async function handleEscalation(
  workspaceId: string,
  ticketId: string,
  reason: string,
): Promise<void> {
  const admin = createAdminClient();

  const { data: ticket } = await admin
    .from("tickets")
    .select("ai_turn_count, channel, subject, customer_id, customers(email, first_name)")
    .eq("id", ticketId)
    .single();

  if (!ticket) return;

  const turnCount = ticket.ai_turn_count || 0;
  const channel = ticket.channel || "email";
  const isChatChannel = channel === "chat" || channel === "help_center";
  const customer = ticket.customers as unknown as { email: string; first_name: string | null } | null;

  // Always: clear AI handling state. If chat channel, switch to email for agent follow-up.
  await admin.from("tickets").update({
    ai_handled: false,
    handled_by: null,
    escalation_reason: reason,
    auto_reply_at: null,
    pending_auto_reply: null,
    status: "open",
    ...(isChatChannel ? { channel: "email" } : {}),
  }).eq("id", ticketId);

  // If chat channel, send a message in the chat telling customer they'll get an email
  if (isChatChannel && customer) {
    const firstName = customer.first_name || "";
    const escalateMsg = firstName
      ? `Thanks ${firstName}! I'm going to escalate this internally, and our team will reach out to you at ${customer.email} shortly.`
      : `Thanks for reaching out! I'm going to escalate this internally, and our team will follow up with you at ${customer.email} shortly.`;

    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      body: escalateMsg,
      author_type: "ai",
      visibility: "external",
    });
  }

  // Branch on reason
  switch (reason) {
    case "cancellation_intent": {
      await addInternalNote(admin, ticketId, `Cancellation intent detected on turn ${turnCount}. Escalated for human review.`);
      // Assign to admin/owner
      await assignToAdmin(admin, workspaceId, ticketId);
      break;
    }

    case "billing_dispute":
    case "chargeback":
    case "fraud": {
      await addInternalNote(admin, ticketId, `Billing dispute/escalation detected on turn ${turnCount}. Reason: ${reason}. Assigned to admin for urgent review.`);
      await assignToAdmin(admin, workspaceId, ticketId);
      break;
    }

    case "human_requested": {
      await addInternalNote(admin, ticketId, `Customer requested human on turn ${turnCount}. Assigned to agent.`);
      await assignToAgent(admin, workspaceId, ticketId);
      break;
    }

    case "turn_limit_reached": {
      await addInternalNote(admin, ticketId, `AI turn limit reached (${turnCount} turns). Full conversation history available. Assigned to agent.`);
      await assignToAgent(admin, workspaceId, ticketId);
      break;
    }

    case "negative_sentiment":
    case "negative_sentiment_detected": {
      await addInternalNote(admin, ticketId, `Negative sentiment detected on turn ${turnCount}. AI paused to prevent further friction. Assigned to agent.`);
      await assignToAgent(admin, workspaceId, ticketId);
      break;
    }

    case "low_confidence": {
      await addInternalNote(admin, ticketId, `AI response below confidence threshold on turn ${turnCount}. Draft saved for agent review.`);
      await assignToAgent(admin, workspaceId, ticketId);
      break;
    }

    default: {
      await addInternalNote(admin, ticketId, `Escalated: ${reason} (turn ${turnCount}).`);
      await assignToAgent(admin, workspaceId, ticketId);
    }
  }

  // Create notification
  await admin.from("dashboard_notifications").insert({
    workspace_id: workspaceId,
    type: "system",
    title: `Ticket escalated: ${reason.replace(/_/g, " ")}`,
    body: `${ticket.subject || "Ticket"} — AI paused after ${turnCount} turn${turnCount !== 1 ? "s" : ""}`,
    link: `/dashboard/tickets/${ticketId}`,
    metadata: { ticket_id: ticketId, reason },
  });

  // Slack notification
  dispatchSlackNotification(workspaceId, "escalation", {
    ticketId,
    ticketNumber: ticket.subject || ticketId,
    customer: { name: customer?.first_name || undefined, email: customer?.email },
    reason: reason.replace(/_/g, " "),
  }).catch(() => {});
}

async function addInternalNote(
  admin: ReturnType<typeof createAdminClient>,
  ticketId: string,
  body: string,
) {
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    body,
    author_type: "system",
    visibility: "internal",
  });
}

async function assignToAdmin(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  ticketId: string,
) {
  const { data: admins } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin"])
    .limit(1);

  if (admins?.[0]) {
    await admin.from("tickets").update({ assigned_to: admins[0].user_id }).eq("id", ticketId);
  }
}

async function assignToAgent(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  ticketId: string,
) {
  // Round-robin: pick agent with fewest open tickets
  const { data: members } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin", "agent"]);

  if (!members?.length) return;

  // Count open tickets per member
  let bestAgent = members[0].user_id;
  let bestCount = Infinity;

  for (const m of members) {
    const { count } = await admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("assigned_to", m.user_id)
      .eq("status", "open");

    if ((count || 0) < bestCount) {
      bestCount = count || 0;
      bestAgent = m.user_id;
    }
  }

  await admin.from("tickets").update({ assigned_to: bestAgent }).eq("id", ticketId);
}
