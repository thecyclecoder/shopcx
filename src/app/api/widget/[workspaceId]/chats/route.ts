import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: List chat sessions for a customer — no auth (public widget)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const url = new URL(request.url);
  const email = url.searchParams.get("email");

  if (!email) return NextResponse.json([]);

  const admin = createAdminClient();

  // Find customer
  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("email", email.toLowerCase())
    .single();

  if (!customer) return NextResponse.json([]);

  // Get their chat sessions with ticket info
  const { data: sessions } = await admin
    .from("widget_sessions")
    .select("id, ticket_id, created_at")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!sessions?.length) return NextResponse.json([]);

  // Enrich with ticket data
  const ticketIds = sessions.map(s => s.ticket_id).filter(Boolean);
  const { data: tickets } = await admin
    .from("tickets")
    .select("id, subject, status, updated_at")
    .in("id", ticketIds);

  const ticketMap = new Map((tickets || []).map(t => [t.id, t]));

  // Get last message for each ticket
  const chats = [];
  for (const s of sessions) {
    if (!s.ticket_id) continue;
    const ticket = ticketMap.get(s.ticket_id);
    if (!ticket) continue;

    const { data: lastMsg } = await admin
      .from("ticket_messages")
      .select("body, direction")
      .eq("ticket_id", s.ticket_id)
      .eq("visibility", "external")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    chats.push({
      id: s.id,
      ticket_id: s.ticket_id,
      subject: ticket.subject || "Chat",
      status: ticket.status,
      last_message: (lastMsg?.body || "").replace(/<[^>]+>/g, "").slice(0, 80),
      updated_at: ticket.updated_at,
    });
  }

  return NextResponse.json(chats);
}
