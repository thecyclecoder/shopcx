import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateDailyReport } from "@/lib/daily-analysis-report";

/**
 * Daily AI analysis reports.
 *
 *   GET ?date=YYYY-MM-DD   → single report + linked proposal rows
 *   GET                    → most recent 14 reports (list view)
 *
 *   POST { date, regenerate? } → generate (or regenerate) the report
 *                                 for a given date. Returns the report row.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const date = req.nextUrl.searchParams.get("date");

  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "bad_date" }, { status: 400 });
    const { data: report } = await admin.from("daily_analysis_reports")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("date", date)
      .maybeSingle();

    if (!report) return NextResponse.json({ report: null });

    // Hydrate proposed rules so the UI can render approve/reject inline
    const sIds = (report.proposed_sonnet_prompt_ids as string[]) || [];
    const gIds = (report.proposed_grader_prompt_ids as string[]) || [];

    const [sonnet, grader] = await Promise.all([
      sIds.length
        ? admin.from("sonnet_prompts").select("id, title, content, category, status, enabled").in("id", sIds)
        : Promise.resolve({ data: [] }),
      gIds.length
        ? admin.from("grader_prompts").select("id, title, content, status").in("id", gIds)
        : Promise.resolve({ data: [] }),
    ]);

    return NextResponse.json({
      report,
      proposed_sonnet_prompts: sonnet.data || [],
      proposed_grader_prompts: grader.data || [],
    });
  }

  const { data: list } = await admin.from("daily_analysis_reports")
    .select("id, date, analyzed_count, avg_score, admin_corrected_count, summary, proposed_sonnet_prompt_ids, proposed_grader_prompt_ids")
    .eq("workspace_id", workspaceId)
    .order("date", { ascending: false })
    .limit(14);

  return NextResponse.json({ reports: list || [] });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const date = body.date as string | undefined;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "bad_date" }, { status: 400 });
  }

  // Regenerate? Wipe the proposed rules from the previous run so we don't
  // accumulate dupes when an admin asks for a fresh take.
  if (body.regenerate) {
    const { data: existing } = await admin.from("daily_analysis_reports")
      .select("proposed_sonnet_prompt_ids, proposed_grader_prompt_ids")
      .eq("workspace_id", workspaceId).eq("date", date).maybeSingle();
    if (existing) {
      const sIds = (existing.proposed_sonnet_prompt_ids as string[]) || [];
      const gIds = (existing.proposed_grader_prompt_ids as string[]) || [];
      // Only delete rules still in 'proposed' state — preserve any the admin already approved.
      if (sIds.length) await admin.from("sonnet_prompts").delete().in("id", sIds).eq("status", "proposed");
      if (gIds.length) await admin.from("grader_prompts").delete().in("id", gIds).eq("status", "proposed");
    }
  }

  const result = await generateDailyReport(workspaceId, date, "manual", user.email || user.id);
  if (!result.ok) return NextResponse.json({ error: result.reason || "generate_failed" }, { status: 400 });

  const { data: report } = await admin.from("daily_analysis_reports")
    .select("*").eq("id", result.reportId!).single();
  return NextResponse.json({ report });
}
