import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function getDateRange(range: string): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (range) {
    case "today":
      return { start: startOfToday.toISOString(), end };
    case "yesterday": {
      const yesterday = new Date(startOfToday);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: yesterday.toISOString(), end: startOfToday.toISOString() };
    }
    case "7d":
      return { start: new Date(now.getTime() - 7 * 86400000).toISOString(), end };
    case "30d":
      return { start: new Date(now.getTime() - 30 * 86400000).toISOString(), end };
    case "all":
      return { start: "2020-01-01T00:00:00Z", end };
    default:
      return { start: new Date(now.getTime() - 7 * 86400000).toISOString(), end };
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "7d";
  const { start, end } = getDateRange(range);

  const admin = createAdminClient();

  // Fetch all portal events in date range
  const { data: events } = await admin
    .from("customer_events")
    .select("event_type, created_at, properties")
    .eq("workspace_id", workspaceId)
    .like("event_type", "portal.%")
    .gte("created_at", start)
    .lte("created_at", end)
    .order("created_at", { ascending: true });

  const allEvents = events || [];

  // ── Portal Session Funnel ──
  // Count portal sessions (bootstrap = page load)
  // Group actions by type
  const actionCounts: Record<string, number> = {};
  let sessionCount = 0;

  for (const e of allEvents) {
    const type = e.event_type as string;

    // Map event types to friendly action names
    if (type === "portal.bootstrap") { sessionCount++; continue; }

    const actionMap: Record<string, string> = {
      "portal.subscription.paused": "Paused subscription",
      "portal.subscription.resumed": "Resumed subscription",
      "portal.subscription.reactivated": "Reactivated subscription",
      "portal.subscription.cancel_reason": "Started cancel flow",
      "portal.subscription.cancelled": "Cancelled",
      "portal.subscription.saved": "Saved by remedy",
      "portal.subscription.item_modified": "Modified items",
      "portal.items.swapped": "Swapped items",
      "portal.coupon.applied": "Applied coupon",
      "portal.coupon.removed": "Removed coupon",
      "portal.loyalty.applied": "Applied loyalty reward",
      "portal.loyalty.redeemed": "Redeemed loyalty points",
      "portal.date.changed": "Changed delivery date",
      "portal.frequency.changed": "Changed frequency",
      "portal.address.updated": "Updated address",
    };

    const label = actionMap[type] || type.replace("portal.", "").replace(/\./g, " ");
    actionCounts[label] = (actionCounts[label] || 0) + 1;
  }

  // Sort actions by count descending
  const portalActions = Object.entries(actionCounts)
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);

  // ── Cancel Flow Funnel ──
  const cancelStarts = allEvents.filter(e => e.event_type === "portal.subscription.cancel_reason");
  const cancellations = allEvents.filter(e => e.event_type === "portal.subscription.cancelled");
  const saves = allEvents.filter(e => e.event_type === "portal.subscription.saved");

  // Cancel reasons breakdown
  const reasonCounts: Record<string, number> = {};
  for (const e of cancelStarts) {
    const reason = (e.properties as Record<string, unknown>)?.reason as string || "unknown";
    const label = (e.properties as Record<string, unknown>)?.reasonType as string || "remedy";
    const key = `${reason}|${label}`;
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  }

  const cancelReasons = Object.entries(reasonCounts)
    .map(([key, count]) => {
      const [reason, type] = key.split("|");
      return { reason, type, count };
    })
    .sort((a, b) => b.count - a.count);

  // ── Remedy Performance ──
  const { data: remedyData } = await admin
    .from("remedy_outcomes")
    .select("remedy_id, remedy_type, outcome, shown, cancel_reason")
    .eq("workspace_id", workspaceId)
    .eq("shown", true)
    .gte("created_at", start)
    .lte("created_at", end);

  const remedyStats: Record<string, { shown: number; accepted: number; passed_over: number; rejected: number }> = {};
  for (const r of remedyData || []) {
    const type = r.remedy_type || "unknown";
    if (!remedyStats[type]) remedyStats[type] = { shown: 0, accepted: 0, passed_over: 0, rejected: 0 };
    remedyStats[type].shown++;
    if (r.outcome === "accepted") remedyStats[type].accepted++;
    else if (r.outcome === "passed_over") remedyStats[type].passed_over++;
    else if (r.outcome === "rejected") remedyStats[type].rejected++;
  }

  const remedyPerformance = Object.entries(remedyStats)
    .map(([type, stats]) => ({
      type,
      ...stats,
      acceptance_rate: stats.shown > 0 ? Math.round((stats.accepted / stats.shown) * 100) : 0,
    }))
    .sort((a, b) => b.shown - a.shown);

  // ── Summary Stats ──
  const cancelFlowStarts = cancelStarts.length;
  const totalSaves = saves.length;
  const totalCancellations = cancellations.length;
  const abandonCount = Math.max(0, cancelFlowStarts - totalSaves - totalCancellations);
  const saveRate = cancelFlowStarts > 0 ? Math.round((totalSaves / cancelFlowStarts) * 100) : 0;

  // Top remedy (by acceptance rate with min 5 shows)
  const topRemedy = remedyPerformance.filter(r => r.shown >= 5).sort((a, b) => b.acceptance_rate - a.acceptance_rate)[0] || null;

  // ── Error Log ──
  const { data: errorEvents } = await admin
    .from("customer_events")
    .select("customer_id, event_type, summary, properties, created_at")
    .eq("workspace_id", workspaceId)
    .eq("event_type", "portal.error")
    .gte("created_at", start)
    .lte("created_at", end)
    .order("created_at", { ascending: false })
    .limit(50);

  // Resolve customer names for error log
  const errorCustomerIds = [...new Set((errorEvents || []).map(e => e.customer_id))];
  const customerNames: Record<string, string> = {};
  if (errorCustomerIds.length) {
    const { data: customers } = await admin.from("customers").select("id, first_name, last_name, email").in("id", errorCustomerIds);
    for (const c of customers || []) {
      customerNames[c.id] = `${c.first_name || ""} ${c.last_name || ""}`.trim() || c.email || c.id;
    }
  }

  const errorLog = (errorEvents || []).map(e => ({
    timestamp: e.created_at,
    customer: customerNames[e.customer_id] || e.customer_id,
    customer_id: e.customer_id,
    route: (e.properties as Record<string, unknown>)?.route || "unknown",
    error: (e.properties as Record<string, unknown>)?.error || "unknown",
    message: (e.properties as Record<string, unknown>)?.message || null,
    appstle_details: (e.properties as Record<string, unknown>)?.appstle_details || null,
    request_payload: (e.properties as Record<string, unknown>)?.request_payload || null,
  }));

  return NextResponse.json({
    range,
    error_log: errorLog,
    summary: {
      sessions: sessionCount,
      cancel_flow_starts: cancelFlowStarts,
      saves: totalSaves,
      cancellations: totalCancellations,
      abandons: abandonCount,
      save_rate: saveRate,
      top_remedy: topRemedy ? { type: topRemedy.type, rate: topRemedy.acceptance_rate } : null,
    },
    portal_actions: portalActions,
    cancel_reasons: cancelReasons,
    remedy_performance: remedyPerformance,
    cancel_funnel: {
      started: cancelFlowStarts,
      shown_remedies: (remedyData || []).filter(r => r.shown).length > 0 ? new Set((remedyData || []).map(r => r.cancel_reason)).size : 0,
      saved: totalSaves,
      cancelled: totalCancellations,
      abandoned: abandonCount,
    },
  });
}
