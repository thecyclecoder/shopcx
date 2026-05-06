import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const { data } = await admin.from("ticket_analyses")
      .select("id, ticket_id, score, admin_score, issues, summary, created_at")
      .eq("workspace_id", workspaceId)
      .gte("created_at", todayStart.toISOString())
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

    return NextResponse.json({
      analyzed: rows.length,
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
    const start = new Date(date + "T00:00:00.000Z").toISOString();
    const end = new Date(new Date(date + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000).toISOString();
    const { data } = await admin.from("ticket_analyses")
      .select("id, ticket_id, score, admin_score, admin_score_reason, summary, issues, action_items, created_at, cost_cents, ai_message_count, trigger, tickets(subject, customer_id)")
      .eq("workspace_id", workspaceId)
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    return NextResponse.json({ analyses: data || [] });
  }

  // daily rollups (default) — last 14 days
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  fourteenDaysAgo.setHours(0, 0, 0, 0);
  const { data } = await admin.from("ticket_analyses")
    .select("score, admin_score, issues, action_items, created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", fourteenDaysAgo.toISOString())
    .order("created_at", { ascending: false });

  // Group by date
  const byDate: Record<string, { scores: number[]; issues: Record<string, number>; actions: number; corrected: number }> = {};
  for (const r of (data || [])) {
    const d = (r.created_at as string).slice(0, 10);
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
