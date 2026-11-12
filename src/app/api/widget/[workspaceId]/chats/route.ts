import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: List chat sessions the caller can PROVE are theirs.
//
// Proof = widget_sessions ids this browser created and stored in localStorage,
// passed back as ?session_id= (repeatable and/or comma-separated). We only ever
// list tickets belonging to those exact session ids, scoped to this workspace.
//
// An email-only request (no session_id) returns { chats: [] } — NOT an error, so
// old cached widget bundles that still send ?email= degrade quietly to "no past
// chats" instead of leaking. This closes the read-by-email hole where anyone who
// knew a shopper's email could list their chats cross-origin (CORS is `*` here).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const url = new URL(request.url);

  // Collect the session ids the browser claims to hold: repeated ?session_id=
  // and/or comma-separated values. The email param is intentionally ignored.
  const sessionIds = url.searchParams
    .getAll("session_id")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  // No proof → no listing, regardless of any email param present.
  if (!sessionIds.length) return NextResponse.json({ chats: [] });

  const admin = createAdminClient();

  // Only sessions in THIS workspace whose id the browser actually holds.
  const { data: sessions } = await admin
    .from("widget_sessions")
    .select("id, ticket_id, created_at")
    .eq("workspace_id", workspaceId)
    .in("id", sessionIds)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!sessions?.length) return NextResponse.json({ chats: [] });

  // Enrich with ticket data — only show tickets still on chat channel
  const ticketIds = sessions.map((s) => s.ticket_id).filter(Boolean);
  const { data: tickets } = await admin
    .from("tickets")
    .select("id, subject, status, channel, updated_at")
    .in("id", ticketIds)
    .eq("channel", "chat");

  const ticketMap = new Map((tickets || []).map((t) => [t.id, t]));

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

  return NextResponse.json({ chats });
}
