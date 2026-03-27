import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { sendTicketReply } from "@/lib/email";
import { sendSMS } from "@/lib/twilio";
import { evaluateRules } from "@/lib/rules-engine";
import { sendMetaDM, replyToComment } from "@/lib/meta";
import { decrypt } from "@/lib/crypto";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const body = await request.json();
  const { body: messageBody, visibility = "external" } = body;

  if (!messageBody?.trim()) {
    return NextResponse.json({ error: "Message body is required" }, { status: 400 });
  }

  // Get ticket with customer info
  const { data: ticket } = await admin
    .from("tickets")
    .select("*, customers(email, phone)")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // Create message
  const message: Record<string, unknown> = {
    ticket_id: ticketId,
    direction: "outbound",
    visibility,
    author_type: "agent",
    author_id: user.id,
    body: messageBody,
  };

  // Send reply via appropriate channel
  let emailError: string | undefined;
  let emailSuppressed = false;
  let metaError: string | undefined;

  if (visibility === "external") {
    const isMetaChannel = ticket.channel === "meta_dm" || ticket.channel === "social_comments";

    if (isMetaChannel && ticket.meta_sender_id) {
      // Send via Meta Graph API
      const { data: workspace } = await admin
        .from("workspaces")
        .select("meta_page_access_token_encrypted, sandbox_mode")
        .eq("id", workspaceId)
        .single();

      const isSandbox = workspace?.sandbox_mode ?? true;
      if (isSandbox) {
        emailSuppressed = true;
      } else if (workspace?.meta_page_access_token_encrypted) {
        const pageToken = decrypt(workspace.meta_page_access_token_encrypted);

        if (ticket.channel === "meta_dm") {
          const result = await sendMetaDM(pageToken, ticket.meta_sender_id, messageBody);
          if (result.error) metaError = result.error;
          else if (result.messageId) message.meta_message_id = result.messageId;
        } else if (ticket.channel === "social_comments" && ticket.meta_comment_id) {
          const result = await replyToComment(pageToken, ticket.meta_comment_id, messageBody);
          if (result.error) metaError = result.error;
          else if (result.commentId) message.meta_message_id = result.commentId;
        }
      } else {
        metaError = "Meta not connected";
      }
    } else if (ticket.customers?.email) {
      // Send via email
      const { data: workspace } = await admin
        .from("workspaces")
        .select("name, sandbox_mode, resend_domain")
        .eq("id", workspaceId)
        .single();

      const isSandbox = workspace?.sandbox_mode ?? true;
      const inboundAddress = workspace?.resend_domain ? `inbound@${workspace.resend_domain}` : null;
      const isInboundTicket = ticket.received_at_email === inboundAddress || !ticket.received_at_email;
      const shouldSendEmail = !isSandbox || isInboundTicket;

      if (!shouldSendEmail) {
        emailSuppressed = true;
      } else {
        const result = await sendTicketReply({
          workspaceId,
          toEmail: ticket.customers.email,
          subject: ticket.subject || "Support Request",
          body: messageBody,
          inReplyTo: ticket.email_message_id,
          agentName: user.user_metadata?.full_name || user.user_metadata?.name || "Support",
          workspaceName: workspace?.name || "ShopCX",
        });

        if (result.error) {
          emailError = result.error;
        } else if (result.messageId) {
          message.email_message_id = result.messageId;
        }
      }
    }
  }

  const { data: created, error } = await admin
    .from("ticket_messages")
    .insert(message)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Auto-transitions
  const ticketUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // First outbound external message → set first_response_at
  if (visibility === "external" && !ticket.first_response_at) {
    ticketUpdates.first_response_at = new Date().toISOString();
  }

  // Agent reply on open ticket → pending
  if (visibility === "external" && ticket.status === "open") {
    ticketUpdates.status = "pending";
  }

  // Mark agent intervention for multi-turn AI awareness
  if (visibility === "external") {
    ticketUpdates.agent_intervened = true;
  }

  await admin.from("tickets").update(ticketUpdates).eq("id", ticketId);

  // Evaluate rules on message sent
  const { data: updatedTicket } = await admin.from("tickets").select("*").eq("id", ticketId).single();
  const { data: custData } = ticket.customer_id
    ? await admin.from("customers").select("*").eq("id", ticket.customer_id).single()
    : { data: null };
  await evaluateRules(ticket.workspace_id, "ticket.message_sent", {
    ticket: updatedTicket || undefined,
    customer: custData || undefined,
    message: { body, direction: "outbound", author_type: "agent", visibility },
  });

  return NextResponse.json({
    message: created,
    email_sent: visibility === "external" && !emailError && !metaError && !emailSuppressed,
    email_suppressed: emailSuppressed,
    email_error: emailError,
    meta_error: metaError,
  });
}
