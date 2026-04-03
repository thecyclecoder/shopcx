import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const body = await req.json();
  const { email, name, message, session_id } = body as {
    email: string;
    name?: string;
    message: string;
    session_id?: string;
  };

  if (!email || !message) {
    return NextResponse.json({ error: "email and message required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify workspace exists and widget is enabled
  const { data: ws } = await admin
    .from("workspaces")
    .select("id, widget_enabled")
    .eq("id", workspaceId)
    .single();

  if (!ws) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (!ws.widget_enabled) {
    return NextResponse.json({ error: "Chat widget is not enabled" }, { status: 403 });
  }

  // Find or create customer
  const normalizedEmail = email.toLowerCase().trim();
  let { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("email", normalizedEmail)
    .single();

  if (!customer) {
    const { data: created } = await admin
      .from("customers")
      .insert({
        workspace_id: workspaceId,
        email: normalizedEmail,
        first_name: name || null,
      })
      .select("id")
      .single();
    customer = created;
  }

  const customerId = customer?.id || null;

  // Check for existing session with open ticket
  let ticketId: string | null = null;
  let sessionId = session_id || null;

  if (sessionId) {
    const { data: session } = await admin
      .from("widget_sessions")
      .select("id, ticket_id")
      .eq("id", sessionId)
      .eq("workspace_id", workspaceId)
      .single();

    if (session?.ticket_id) {
      // Check ticket is still open/pending
      const { data: ticket } = await admin
        .from("tickets")
        .select("id, status, channel")
        .eq("id", session.ticket_id)
        .single();

      if (ticket && ticket.channel === "chat" && ticket.status !== "archived") {
        ticketId = ticket.id;
        // Reopen if closed (customer reply reopens the conversation)
        if (ticket.status === "closed") {
          await admin.from("tickets").update({
            status: "open",
            closed_at: null,
            last_customer_reply_at: new Date().toISOString(),
          }).eq("id", ticket.id);
        }
      }
      // If ticket was escalated to email (channel switched), don't reuse — new chat needed

      // Update session activity
      await admin
        .from("widget_sessions")
        .update({ last_activity_at: new Date().toISOString() })
        .eq("id", session.id);
    }
  }

  // Create new ticket if needed
  if (!ticketId) {
    const { data: ticket } = await admin
      .from("tickets")
      .insert({
        workspace_id: workspaceId,
        customer_id: customerId,
        channel: "chat",
        status: "open",
        subject: message.slice(0, 80) || "Live Chat",
        last_customer_reply_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    ticketId = ticket?.id || null;

    if (ticketId) {
      // Create or update session
      if (sessionId) {
        await admin
          .from("widget_sessions")
          .update({
            ticket_id: ticketId,
            customer_id: customerId,
            last_activity_at: new Date().toISOString(),
          })
          .eq("id", sessionId);
      } else {
        const { data: session } = await admin
          .from("widget_sessions")
          .insert({
            workspace_id: workspaceId,
            ticket_id: ticketId,
            customer_id: customerId,
            email: normalizedEmail,
            name: name || null,
          })
          .select("id")
          .single();
        sessionId = session?.id || null;
      }
    }
  }

  if (!ticketId) {
    return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
  }

  // Insert message
  const { data: msg } = await admin
    .from("ticket_messages")
    .insert({
      ticket_id: ticketId,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body: message,
    })
    .select("id")
    .single();

  // Update ticket timestamps
  await admin
    .from("tickets")
    .update({
      status: "open",
      last_customer_reply_at: new Date().toISOString(),
    })
    .eq("id", ticketId);

  // Fire AI reply event if AI enabled for chat
  const { data: aiConfig } = await admin
    .from("ai_channel_config")
    .select("enabled")
    .eq("workspace_id", workspaceId)
    .eq("channel", "chat")
    .single();

  if (aiConfig?.enabled) {
    // Check ticket assignment — only trigger AI if unassigned or AI-handled
    const { data: ticket } = await admin
      .from("tickets")
      .select("assigned_to, handled_by")
      .eq("id", ticketId)
      .single();

    const handledBy = ticket?.handled_by || "";
    const isAutoHandled = handledBy === "AI Agent" || handledBy.startsWith("Workflow:") || handledBy.startsWith("Journey:");
    const isUnassigned = !ticket?.assigned_to && !handledBy;

    // Trigger AI for: AI-handled, workflow-handled, journey-handled, or unassigned
    if (isAutoHandled || isUnassigned) {
      await inngest.send({
        name: "ticket/inbound-message",
        data: {
          workspace_id: workspaceId,
          ticket_id: ticketId,
          message_body: message,
          channel: "chat",
          is_new_ticket: false,
        },
      });

      return NextResponse.json({
        ticket_id: ticketId,
        session_id: sessionId,
        message_id: msg?.id,
        expecting_reply: true,
      });
    }
  }

  return NextResponse.json({
    ticket_id: ticketId,
    session_id: sessionId,
    message_id: msg?.id,
    expecting_reply: false,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const sessionId = req.nextUrl.searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: session } = await admin
    .from("widget_sessions")
    .select("ticket_id")
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!session?.ticket_id) {
    return NextResponse.json({ messages: [] });
  }

  const { data: messages } = await admin
    .from("ticket_messages")
    .select("id, direction, author_type, body, visibility, created_at")
    .eq("ticket_id", session.ticket_id)
    .eq("visibility", "external")
    .order("created_at", { ascending: true });

  return NextResponse.json({
    ticket_id: session.ticket_id,
    messages: messages || [],
  });
}
