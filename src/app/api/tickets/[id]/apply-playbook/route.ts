import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST — Apply a playbook to a ticket with agent-provided context.
 * The context is injected as an internal message so the playbook executor
 * treats it like a customer message and can extract intent/order info.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: ticketId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const { playbook_id, context } = body;

  if (!playbook_id) {
    return NextResponse.json({ error: "playbook_id is required" }, { status: 400 });
  }

  // Verify ticket exists and get workspace
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, workspace_id, customer_id, status, channel")
    .eq("id", ticketId)
    .single();

  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // Verify playbook exists
  const { data: playbook } = await admin
    .from("playbooks")
    .select("id, name")
    .eq("id", playbook_id)
    .eq("workspace_id", ticket.workspace_id)
    .single();

  if (!playbook) return NextResponse.json({ error: "Playbook not found" }, { status: 404 });

  // Get agent display name
  const { data: member } = await admin
    .from("workspace_members")
    .select("display_name")
    .eq("workspace_id", ticket.workspace_id)
    .eq("user_id", user.id)
    .single();

  const agentName = member?.display_name || "Agent";

  // Insert context as an internal system message so the playbook can read it
  if (context?.trim()) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "inbound",
      visibility: "internal",
      author_type: "system",
      body: `[Agent Context — ${agentName}] ${context.trim()}`,
    });
  }

  // Assign playbook to ticket
  await admin.from("tickets").update({
    active_playbook_id: playbook_id,
    playbook_step: 0,
    playbook_context: context?.trim()
      ? { agent_context: context.trim(), applied_by: agentName }
      : { applied_by: agentName },
    playbook_exceptions_used: 0,
    status: "closed",
    handled_by: `Playbook: ${playbook.name}`,
    updated_at: new Date().toISOString(),
  }).eq("id", ticketId);

  // Add visible internal note
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `${agentName} applied playbook "${playbook.name}"${context?.trim() ? ` with context: "${context.trim()}"` : ""}.`,
  });

  // Fire the playbook by sending an Inngest event
  try {
    const inngestKey = process.env.INNGEST_EVENT_KEY;
    if (inngestKey) {
      await fetch(process.env.INNGEST_EVENT_URL || "https://inn.gs/e", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${inngestKey}` },
        body: JSON.stringify({
          name: "ticket/inbound-message",
          data: {
            ticket_id: ticketId,
            workspace_id: ticket.workspace_id,
            message_body: "playbook-apply",
            channel: ticket.channel || "email",
            is_new_ticket: false,
          },
        }),
      });
    }
  } catch {
    // Non-fatal — playbook will execute on next inbound message
  }

  return NextResponse.json({ success: true, playbook_name: playbook.name });
}
