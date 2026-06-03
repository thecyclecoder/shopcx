/**
 * GET /api/workspaces/[id]/csat
 * Returns CSAT stats + recent responses for the dashboard.
 *
 * Stats:
 *   - count        — total CSATs submitted in the window
 *   - avg_rating   — average across all submitted
 *   - by_rating    — histogram of 1..5
 *   - response_rate — % of csat_sent_at tickets in window that submitted
 *   - reopen_rate  — % of sent CSATs whose tickets got reopened (csat:reopened tag)
 *
 * Recent: 50 most recent responses with rating, comment, ticket subject,
 * customer name, points awarded, submitted_at.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin", "agent"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const days = Math.min(parseInt(url.searchParams.get("days") || "30", 10) || 30, 365);
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const [{ data: rated }, { count: sentCount }, { count: reopenCount }] = await Promise.all([
    admin.from("ticket_csat")
      .select("id, rating, comment, submitted_at, points_awarded, customer_id, ticket_id, tickets(subject), customers(first_name, last_name, email)")
      .eq("workspace_id", workspaceId)
      .gte("submitted_at", since)
      .order("submitted_at", { ascending: false })
      .limit(200),
    admin.from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("csat_sent_at", since)
      .not("csat_sent_at", "is", null),
    admin.from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("csat_sent_at", since)
      .not("csat_sent_at", "is", null)
      .contains("tags", ["csat:reopened"]),
  ]);

  const responses = rated || [];
  const count = responses.length;
  const sum = responses.reduce((s, r) => s + (r.rating as number), 0);
  const avg = count ? sum / count : 0;
  const byRating: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const r of responses) byRating[String(r.rating)] = (byRating[String(r.rating)] || 0) + 1;

  return NextResponse.json({
    stats: {
      count,
      avg_rating: avg,
      by_rating: byRating,
      sent: sentCount || 0,
      response_rate: sentCount ? count / sentCount : 0,
      reopened: reopenCount || 0,
      reopen_rate: sentCount ? (reopenCount || 0) / sentCount : 0,
    },
    responses: responses.slice(0, 50).map(r => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      submitted_at: r.submitted_at,
      points_awarded: r.points_awarded,
      ticket_id: r.ticket_id,
      ticket_subject: (r.tickets as { subject?: string } | null)?.subject || null,
      customer_name: (() => {
        const c = r.customers as { first_name?: string; last_name?: string; email?: string } | null;
        if (!c) return null;
        const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
        return name || c.email || null;
      })(),
    })),
  });
}

/**
 * POST /api/workspaces/[id]/csat
 * Body: { action: "create_ticket", csat_id }
 *
 * Creates a new ticket from a CSAT comment when the customer used
 * the comment field to slip in a new request (e.g. "5 stars but I
 * actually need to cancel my subscription"). The comment goes in
 * as the first inbound message on the new ticket. Returns the
 * new ticket_id for client-side redirect.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin", "agent"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  if (body.action !== "create_ticket") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const csatId = String(body.csat_id || "");
  if (!csatId) return NextResponse.json({ error: "csat_id required" }, { status: 400 });

  const { data: csat } = await admin
    .from("ticket_csat")
    .select("id, rating, comment, customer_id, ticket_id, submitted_at")
    .eq("workspace_id", workspaceId)
    .eq("id", csatId)
    .maybeSingle();
  if (!csat) return NextResponse.json({ error: "CSAT not found" }, { status: 404 });
  if (!csat.comment?.trim()) return NextResponse.json({ error: "CSAT has no comment to use as ticket body" }, { status: 400 });
  if (!csat.customer_id) return NextResponse.json({ error: "CSAT has no customer_id" }, { status: 400 });

  const commentText = csat.comment.trim();
  const firstLine = commentText.split(/\n/)[0].trim();
  const subject = firstLine.length > 80
    ? firstLine.slice(0, 77) + "…"
    : firstLine || `CSAT follow-up — ${csat.rating}★`;

  // Pull the original ticket's channel + subject so the system note
  // can link back for agent context.
  const { data: srcTicket } = await admin
    .from("tickets").select("channel, subject")
    .eq("id", csat.ticket_id).maybeSingle();

  const now = new Date().toISOString();
  const { data: ticket, error: terr } = await admin.from("tickets").insert({
    workspace_id: workspaceId,
    customer_id: csat.customer_id,
    channel: srcTicket?.channel || "email",
    status: "open",
    subject,
    last_customer_reply_at: csat.submitted_at,
  }).select("id").single();
  if (terr || !ticket) return NextResponse.json({ error: terr?.message || "Ticket insert failed" }, { status: 500 });

  // First inbound message — the CSAT comment.
  await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "inbound",
    visibility: "external",
    author_type: "customer",
    body: `<p>${commentText.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`,
    created_at: csat.submitted_at,
  });

  // System note tying back to the CSAT + the original ticket.
  await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] Created from CSAT (${csat.rating}★) on ticket <a href="/dashboard/tickets/${csat.ticket_id}">${srcTicket?.subject || csat.ticket_id.slice(0, 8)}</a>. The customer's CSAT comment is the first inbound message above.`,
  });

  const { addTicketTag } = await import("@/lib/ticket-tags");
  await addTicketTag(ticket.id, "from_csat");

  // Fire the unified ticket handler so the orchestrator processes
  // this as a real new inbound — pattern-matching, journey trigger,
  // Sonnet decision, action execution. Same event widget chat /
  // email webhook / journey completion all use.
  const { inngest } = await import("@/lib/inngest/client");
  await inngest.send({
    name: "ticket/inbound-message",
    data: {
      workspace_id: workspaceId,
      ticket_id: ticket.id,
      message_body: commentText,
      channel: srcTicket?.channel || "email",
      is_new_ticket: true,
    },
  });

  return NextResponse.json({ ok: true, ticket_id: ticket.id });
}
