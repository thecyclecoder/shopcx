import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { centralDateStr, centralDayWindowUtc, centralTodayStartUtcIso } from "@/lib/central-day";

// GET — rollup of ticket analyses
//   ?view=today          — today's score + count + recent issues
//   ?view=daily          — daily rollups (last 14 days)
//   ?view=tickets&date=YYYY-MM-DD — per-ticket list for a given day
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const view = req.nextUrl.searchParams.get("view") || "daily";
  const date = req.nextUrl.searchParams.get("date");

  const admin = createAdminClient();

  if (view === "today") {
    // "Today" = the Central calendar day (WORKSPACE_TZ), NOT the server's UTC day. setHours(0,0,0,0)
    // on a Vercel (UTC) box snaps the boundary to UTC-midnight, so at ~7 PM+ Central it rolls "today"
    // to tomorrow and scoops a full extra UTC day of volume. Anchor to Central. See [[central-day]].
    const todayIsoStart = centralTodayStartUtcIso();
    const { data } = await admin.from("ticket_analyses")
      .select("id, ticket_id, score, admin_score, issues, summary, created_at")
      .eq("workspace_id", workspaceId)
      .gte("created_at", todayIsoStart)
      .order("created_at", { ascending: false });

    const rows = data || [];
    const scores = rows.map(r => (r.admin_score ?? r.score) as number).filter(s => s != null);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

    // Recent issues (most common types today)
    const issueCounts: Record<string, number> = {};
    for (const r of rows) {
      for (const i of ((r.issues as Array<{type?: string}>) || [])) {
        if (i.type) issueCounts[i.type] = (issueCounts[i.type] || 0) + 1;
      }
    }
    const topIssues = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // Two volume denominators (cora-grades-every-ai-handled-ticket-not-just-sol):
    //   • new_tickets     — inbound tickets CREATED today (the day's fresh volume)
    //   • handled_tickets — tickets whose LAST CUSTOMER MESSAGE is today (can exceed new_tickets:
    //     older tickets a slow-responder came back to). This is the denominator the score sits under.
    // Both exclude merged-away duplicates (the survivor carries the conversation) and outbound-only
    // sends (a ticket with no customer message — e.g. a dunning email — is never a handled convo).
    // handled_cheap vs handled_sol splits the low-cost autonomous path from the Sol-handled one.
    const todayIso = todayIsoStart;
    const { data: custToday } = await admin.from("ticket_messages")
      .select("ticket_id").eq("author_type", "customer").gte("created_at", todayIso);
    const handledIdSet = Array.from(new Set((custToday || []).map(m => m.ticket_id as string)));
    let newTickets = 0, handledTickets = 0, handledCheap = 0, handledSol = 0;
    // The non-merged handled ticket ids — the true "handled today" population. `graded_handled` below
    // counts how many of THESE have a grade, so the card reads "N of <handled> graded" honestly. (The
    // old numerator was `analyzed` = grade rows CREATED today over ANY ticket — a different population,
    // which produced nonsense like "21 of 16".)
    const handledTicketIds: string[] = [];
    if (handledIdSet.length) {
      const { data: htk } = await admin.from("tickets")
        .select("id, merged_into, created_at, ai_handled_at, sol_handled_at")
        .eq("workspace_id", workspaceId)
        .in("id", handledIdSet);
      for (const t of (htk || []) as Array<{ id: string; merged_into: string | null; created_at: string; ai_handled_at: string | null; sol_handled_at: string | null }>) {
        if (t.merged_into) continue; // merged-away duplicate → the survivor is counted instead
        handledTickets++;
        handledTicketIds.push(t.id);
        if (t.sol_handled_at) handledSol++;
        else if (t.ai_handled_at) handledCheap++;
        if (t.created_at >= todayIso) newTickets++;
      }
    }

    // How many of today's handled tickets carry a grade (a ticket_analyses row) — from ANY time, since
    // a grade lands ~30 min after the last customer message. This is the honest numerator for the card.
    let gradedHandled = 0;
    if (handledTicketIds.length) {
      const { data: gradedRows } = await admin.from("ticket_analyses")
        .select("ticket_id")
        .eq("workspace_id", workspaceId)
        .in("ticket_id", handledTicketIds);
      gradedHandled = new Set((gradedRows || []).map(g => g.ticket_id as string)).size;
    }

    return NextResponse.json({
      analyzed: rows.length,
      graded_handled: gradedHandled,
      new_tickets: newTickets,
      handled_tickets: handledTickets,
      handled_cheap: handledCheap,
      handled_sol: handledSol,
      avg_score: avg,
      top_issues: topIssues.map(([type, count]) => ({ type, count })),
      worst_today: rows
        .filter(r => (r.admin_score ?? r.score ?? 10) <= 5)
        .slice(0, 5)
        .map(r => ({
          analysis_id: r.id,
          ticket_id: r.ticket_id,
          score: r.admin_score ?? r.score,
          summary: r.summary,
        })),
    });
  }

  if (view === "tickets" && date) {
    // Bucket by the TICKET'S close date (tickets.updated_at) rather
    // than the analysis row's created_at — keeps the daily detail
    // view aligned with the rollup. A wide created_at filter is used
    // to bound the query, then we narrow client-side by joined
    // ticket.updated_at so we don't accidentally miss late-analyzed
    // tickets whose analysis sits in a later UTC day.
    // `date` is a Central calendar day. Bound the query by the Central day window (UTC instants) and
    // bucket each analysis by the TICKET's close date rendered in Central — NOT a naive .slice(0,10)
    // of the UTC ISO, which would push an evening-Central ticket into the next calendar day. [[central-day]].
    const { start: dayStart } = centralDayWindowUtc(date);
    const wideStart = new Date(new Date(dayStart).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const wideEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data } = await admin
      .from("ticket_analyses")
      .select("id, ticket_id, score, admin_score, admin_score_reason, summary, issues, action_items, created_at, cost_cents, ai_message_count, trigger, tickets(subject, customer_id, updated_at)")
      .eq("workspace_id", workspaceId)
      .gte("created_at", wideStart)
      .lt("created_at", wideEnd)
      .order("created_at", { ascending: false });

    const inDay = (data || []).filter((r) => {
      const t = (r as { tickets?: { updated_at?: string } | null }).tickets?.updated_at;
      const key = centralDateStr(t || (r.created_at as string));
      return key === date;
    });

    return NextResponse.json({ analyses: inDay });
  }

  // Daily rollups (default) — last 14 days. We pull the joined
  // ticket row so each analysis is bucketed by the TICKET'S close
  // date (tickets.updated_at) instead of the analysis row's
  // created_at. Otherwise a backlog of older closed tickets analyzed
  // today all bunch into today's report — which is exactly what
  // happened the first time the cron resumed after a multi-day gap.
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  fourteenDaysAgo.setHours(0, 0, 0, 0);
  const { data } = await admin
    .from("ticket_analyses")
    .select("score, admin_score, issues, action_items, created_at, tickets(updated_at)")
    .eq("workspace_id", workspaceId)
    .gte("created_at", fourteenDaysAgo.toISOString())
    .order("created_at", { ascending: false });

  // Group by ticket close date — fall back to the analysis's own
  // created_at if the joined ticket row is missing for any reason.
  const byDate: Record<string, { scores: number[]; issues: Record<string, number>; actions: number; corrected: number }> = {};
  for (const r of (data || [])) {
    const ticketUpdatedAt = (r as { tickets?: { updated_at?: string } | null }).tickets?.updated_at;
    // Bucket by the Central calendar day (WORKSPACE_TZ), not a UTC .slice(0,10) — otherwise an
    // evening-Central close lands in the next day's row and each daily rollup is off by the
    // UTC-Central offset for late-in-the-day activity. [[central-day]].
    const d = centralDateStr(ticketUpdatedAt || (r.created_at as string));
    if (!byDate[d]) byDate[d] = { scores: [], issues: {}, actions: 0, corrected: 0 };
    const score = (r.admin_score ?? r.score) as number | null;
    if (score != null) byDate[d].scores.push(score);
    for (const i of ((r.issues as Array<{type?: string}>) || [])) {
      if (i.type) byDate[d].issues[i.type] = (byDate[d].issues[i.type] || 0) + 1;
    }
    byDate[d].actions += ((r.action_items as Array<unknown>) || []).length;
    if (r.admin_score != null) byDate[d].corrected++;
  }

  const rollups = Object.entries(byDate)
    .map(([date, agg]) => ({
      date,
      avg_score: agg.scores.length ? agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length : null,
      analyzed: agg.scores.length,
      action_items: agg.actions,
      admin_corrected: agg.corrected,
      top_issues: Object.entries(agg.issues).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([type, count]) => ({ type, count })),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return NextResponse.json({ rollups });
}
