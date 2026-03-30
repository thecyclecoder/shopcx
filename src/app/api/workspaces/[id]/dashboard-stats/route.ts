import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);

  // Time range — defaults to "today"
  const range = url.searchParams.get("range") || "today";
  const tzOffset = -6; // US Central
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffset * 60 * 60 * 1000);
  const todayMidnight = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - tzOffset * 60 * 60 * 1000);

  let rangeStart: string;
  let prevStart: string;
  let rangeEnd: string | null = null;
  if (range === "yesterday") {
    rangeStart = new Date(todayMidnight.getTime() - 86400000).toISOString();
    rangeEnd = todayMidnight.toISOString();
    prevStart = new Date(todayMidnight.getTime() - 2 * 86400000).toISOString();
  } else if (range === "7d") {
    rangeStart = new Date(todayMidnight.getTime() - 7 * 86400000).toISOString();
    prevStart = new Date(todayMidnight.getTime() - 14 * 86400000).toISOString();
  } else if (range === "30d") {
    rangeStart = new Date(todayMidnight.getTime() - 30 * 86400000).toISOString();
    prevStart = new Date(todayMidnight.getTime() - 60 * 86400000).toISOString();
  } else {
    rangeStart = todayMidnight.toISOString();
    prevStart = new Date(todayMidnight.getTime() - 86400000).toISOString();
  }

  // Build range-bounded event queries
  let ticketsRangeQ = admin.from("tickets").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).gte("created_at", rangeStart);
  let ticketsPrevQ = admin.from("tickets").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).gte("created_at", prevStart).lt("created_at", rangeStart);
  let cancelsRangeQ = admin.from("customer_events").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("event_type", "subscription.cancelled").gte("created_at", rangeStart);
  let cancelsPrevQ = admin.from("customer_events").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("event_type", "subscription.cancelled").gte("created_at", prevStart).lt("created_at", rangeStart);
  let failuresRangeQ = admin.from("customer_events").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("event_type", "subscription.billing-failure").gte("created_at", rangeStart);
  let failuresPrevQ = admin.from("customer_events").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("event_type", "subscription.billing-failure").gte("created_at", prevStart).lt("created_at", rangeStart);

  if (rangeEnd) {
    ticketsRangeQ = ticketsRangeQ.lt("created_at", rangeEnd);
    cancelsRangeQ = cancelsRangeQ.lt("created_at", rangeEnd);
    failuresRangeQ = failuresRangeQ.lt("created_at", rangeEnd);
  }

  const [
    customers, ticketsRange, ticketsPrev, kbArticles, macros,
    aiHandled, totalClosed,
    cancelsRange, cancelsPrev, failuresRange, failuresPrev,
    dunningRecovered, dunningActiveFailures, dunningInProgress,
    activeSubs,
  ] = await Promise.all([
    admin.from("customers").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
    ticketsRangeQ,
    ticketsPrevQ,
    admin.from("knowledge_base").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("published", true),
    admin.from("macros").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("active", true),
    admin.from("tickets").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("ai_handled", true),
    admin.from("tickets").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).in("status", ["closed", "archived"]),
    cancelsRangeQ,
    cancelsPrevQ,
    failuresRangeQ,
    failuresPrevQ,
    admin.from("dunning_cycles").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "recovered"),
    admin.from("subscriptions").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("last_payment_status", "failed").eq("status", "active"),
    admin.from("dunning_cycles").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).in("status", ["active", "skipped", "paused"]),
    admin.from("subscriptions").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "active"),
  ]);

  // Compute avg retention — exclude secondary linked profiles
  let avgRetention: number | null = null;
  {
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

  const cnt = (r: unknown) => ((r as { count: number | null }).count || 0);

  return NextResponse.json({
    customers: cnt(customers),
    active_subs: cnt(activeSubs),
    avg_retention: avgRetention,
    ai_resolution_rate: cnt(totalClosed) > 0 ? cnt(aiHandled) / cnt(totalClosed) : null,
    tickets_range: cnt(ticketsRange),
    tickets_prev: cnt(ticketsPrev),
    kb_articles: cnt(kbArticles),
    macros: cnt(macros),
    cancels_range: cnt(cancelsRange),
    cancels_prev: cnt(cancelsPrev),
    failures_range: cnt(failuresRange),
    failures_prev: cnt(failuresPrev),
    dunning_recovered: cnt(dunningRecovered),
    dunning_active_failures: cnt(dunningActiveFailures),
    dunning_in_progress: cnt(dunningInProgress),
  });
}
