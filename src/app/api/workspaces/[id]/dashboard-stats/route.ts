import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Run all queries in parallel
  const [customers, retention, ticketsToday, kbArticles, macros, aiHandled, totalClosed] = await Promise.all([
    // Total customers
    admin.from("customers").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),

    // Average retention score (placeholder — computed below)
    Promise.resolve({ data: null }),

    // Tickets created today
    admin.from("tickets").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),

    // Published KB articles
    admin.from("knowledge_base").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("published", true),

    // Active macros
    admin.from("macros").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("active", true),

    // AI handled tickets (for resolution rate)
    admin.from("tickets").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("ai_handled", true),

    // Total closed tickets
    admin.from("tickets").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "closed"),
  ]);

  // Compute avg retention via simple query if RPC doesn't exist
  let avgRetention = (retention as { data: number | null }).data;
  if (avgRetention == null) {
    const { data: retData } = await admin
      .from("customers")
      .select("retention_score")
      .eq("workspace_id", workspaceId)
      .not("retention_score", "is", null)
      .gt("total_orders", 0)
      .limit(1000);
    if (retData && retData.length > 0) {
      avgRetention = retData.reduce((sum: number, c: { retention_score: number }) => sum + (c.retention_score || 0), 0) / retData.length;
    }
  }

  const aiCount = (aiHandled as { count: number | null }).count || 0;
  const closedCount = (totalClosed as { count: number | null }).count || 0;
  const aiResolutionRate = closedCount > 0 ? aiCount / closedCount : null;

  return NextResponse.json({
    customers: (customers as { count: number | null }).count || 0,
    avg_retention: avgRetention,
    ai_resolution_rate: aiResolutionRate,
    tickets_today: (ticketsToday as { count: number | null }).count || 0,
    kb_articles: (kbArticles as { count: number | null }).count || 0,
    macros: (macros as { count: number | null }).count || 0,
  });
}
