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

  // Compute avg retention — exclude secondary linked profiles to avoid double-counting
  let avgRetention = (retention as { data: number | null }).data;
  if (avgRetention == null) {
    // Get secondary profile IDs to exclude
    const { data: secondaryLinks } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("is_primary", false);
    const excludeIds = (secondaryLinks || []).map(l => l.customer_id);

    const { data: retData } = await admin
      .from("customers")
      .select("id, retention_score")
      .eq("workspace_id", workspaceId)
      .not("retention_score", "is", null)
      .gt("total_orders", 0)
      .limit(1000);

    const filtered = (retData || []).filter(c => !excludeIds.includes(c.id));
    if (filtered.length > 0) {
      avgRetention = filtered.reduce((sum: number, c: { retention_score: number }) => sum + (c.retention_score || 0), 0) / filtered.length;
    }
  }

  const aiCount = (aiHandled as { count: number | null }).count || 0;
  const closedCount = (totalClosed as { count: number | null }).count || 0;
  const aiResolutionRate = closedCount > 0 ? aiCount / closedCount : null;

  // Cancels + payment failures (today vs yesterday) — use US Central time (UTC-6)
  const tzOffset = -6; // US Central — TODO: make this a workspace setting
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffset * 60 * 60 * 1000);
  const todayStart = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - tzOffset * 60 * 60 * 1000).toISOString();
  const yesterdayStart = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() - 1) - tzOffset * 60 * 60 * 1000).toISOString();

  // Use customer_events for accurate cancel + failure counts (webhooks log events)
  const [cancelsToday, cancelsYesterday, failuresToday, failuresYesterday, dunningRecovered, dunningRevenue] = await Promise.all([
    admin.from("customer_events").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).eq("event_type", "subscription.cancelled").gte("created_at", todayStart),
    admin.from("customer_events").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).eq("event_type", "subscription.cancelled").gte("created_at", yesterdayStart).lt("created_at", todayStart),
    admin.from("customer_events").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).eq("event_type", "subscription.billing-failure").gte("created_at", todayStart),
    admin.from("customer_events").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).eq("event_type", "subscription.billing-failure").gte("created_at", yesterdayStart).lt("created_at", todayStart),
    // Dunning saves (all time)
    admin.from("dunning_cycles").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).eq("status", "recovered"),
    // Total failed subscriptions needing dunning
    admin.from("subscriptions").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).eq("last_payment_status", "failed").eq("status", "active"),
  ]);

  const cancTodayCount = (cancelsToday as { count: number | null }).count || 0;
  const cancYestCount = (cancelsYesterday as { count: number | null }).count || 0;
  const failTodayCount = (failuresToday as { count: number | null }).count || 0;
  const failYestCount = (failuresYesterday as { count: number | null }).count || 0;
  const dunningRecoveredCount = (dunningRecovered as { count: number | null }).count || 0;
  const activeFailures = (dunningRevenue as { count: number | null }).count || 0;

  return NextResponse.json({
    customers: (customers as { count: number | null }).count || 0,
    avg_retention: avgRetention,
    ai_resolution_rate: aiResolutionRate,
    tickets_today: (ticketsToday as { count: number | null }).count || 0,
    kb_articles: (kbArticles as { count: number | null }).count || 0,
    macros: (macros as { count: number | null }).count || 0,
    cancels_today: cancTodayCount,
    cancels_yesterday: cancYestCount,
    failures_today: failTodayCount,
    failures_yesterday: failYestCount,
    dunning_recovered: dunningRecoveredCount,
    dunning_active_failures: activeFailures,
  });
}
