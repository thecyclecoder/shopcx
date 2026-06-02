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
