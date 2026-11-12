import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSupportMode, isSoftwareMode } from "@/lib/support-mode";
import { verifyWidgetIdentity } from "@/lib/widget-identity";

// GET: List chat sessions the caller can PROVE are theirs.
//
// cpg workspaces — proof = widget_sessions ids this browser created and stored in
// localStorage, passed back as ?session_id= (repeatable and/or comma-separated). We
// only ever list tickets belonging to those exact session ids, scoped to this
// workspace. An email-only request (no session_id) returns { chats: [] } — NOT an
// error, so old cached widget bundles that still send ?email= degrade quietly to "no
// past chats" instead of leaking. This closes the read-by-email hole where anyone who
// knew a shopper's email could list their chats cross-origin (CORS is `*` here).
//
// software workspaces (ShopGrowth merchant support) — proof = a verified identity pass
// (?identity=). The list is scoped to the store: every ticket tagged `shop:<shop>` from
// the verified pass, so a staff member sees their own store's conversations from any
// device and NOBODY else's. No valid pass → 401. The cpg-side session-id path is never
// taken here. (The cpg read-by-email hole is closed separately by
// widget-past-chats-requires-proof.)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const url = new URL(request.url);

  const admin = createAdminClient();
  const mode = await getSupportMode(workspaceId);

  // ── software mode: a verified pass is required; list the store's own tickets ──
  if (isSoftwareMode(mode)) {
    const identity = url.searchParams.get("identity");
    const pass = identity ? await verifyWidgetIdentity(workspaceId, identity) : null;
    if (!pass) {
      return NextResponse.json({ error: "A verified identity is required" }, { status: 401 });
    }

    // Tickets for THIS store (verified shop tag), chat channel only.
    const { data: tickets } = await admin
      .from("tickets")
      .select("id, subject, status, channel, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("channel", "chat")
      .contains("tags", [`shop:${pass.shop}`])
      .order("updated_at", { ascending: false })
      .limit(20);

    if (!tickets?.length) return NextResponse.json({ chats: [] });

    // Map each ticket back to its widget session id (the handle the UI reloads with).
    const ticketIds = tickets.map((t) => t.id);
    const { data: ticketSessions } = await admin
      .from("widget_sessions")
      .select("id, ticket_id, created_at")
      .eq("workspace_id", workspaceId)
      .in("ticket_id", ticketIds)
      .order("created_at", { ascending: false });
    const sessionByTicket = new Map<string, string>();
    for (const s of ticketSessions || []) {
      if (s.ticket_id && !sessionByTicket.has(s.ticket_id)) sessionByTicket.set(s.ticket_id, s.id);
    }

    const chats = [];
    for (const ticket of tickets) {
      const { data: lastMsg } = await admin
        .from("ticket_messages")
        .select("body, direction")
        .eq("ticket_id", ticket.id)
        .eq("visibility", "external")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      chats.push({
        id: sessionByTicket.get(ticket.id) || ticket.id,
        ticket_id: ticket.id,
        subject: ticket.subject || "Chat",
        status: ticket.status,
        last_message: (lastMsg?.body || "").replace(/<[^>]+>/g, "").slice(0, 80),
        updated_at: ticket.updated_at,
      });
    }

    return NextResponse.json({ chats });
  }

  // ── cpg mode: session-id-proof path (unchanged) ──
  // Collect the session ids the browser claims to hold: repeated ?session_id=
  // and/or comma-separated values. The email param is intentionally ignored.
  const sessionIds = url.searchParams
    .getAll("session_id")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  // No proof → no listing, regardless of any email param present.
  if (!sessionIds.length) return NextResponse.json({ chats: [] });

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
