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
  const range = url.searchParams.get("range") || "14d";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let startDate = new Date(today);
  let endDate = new Date(today);
  let days = 14;

  if (range === "this_month") {
    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    days = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000);
  } else if (range === "next_month") {
    startDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 2, 1);
    days = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000);
  } else if (range === "all") {
    startDate = new Date("2026-01-01");
    endDate = new Date("2027-01-01");
    days = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000);
  } else {
    days = parseInt(range) || 14;
    endDate.setDate(endDate.getDate() + days);
  }

  // ── Fetch all forecasts in date range ──
  let allForecasts: any[] = [];
  let offset = 0;
  while (true) {
    const { data } = await admin
      .from("billing_forecasts")
      .select("expected_date, expected_revenue_cents, actual_revenue_cents, status, forecast_type, created_from, shopify_contract_id")
      .eq("workspace_id", workspaceId)
      .gte("expected_date", startDate.toISOString().slice(0, 10))
      .lt("expected_date", endDate.toISOString().slice(0, 10))
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    allForecasts.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // ── Fetch forecast events in date range ──
  let allEvents: any[] = [];
  offset = 0;
  while (true) {
    const { data } = await admin
      .from("billing_forecast_events")
      .select("forecast_date, event_type, delta_cents")
      .eq("workspace_id", workspaceId)
      .gte("forecast_date", today.toISOString().slice(0, 10))
      .lt("forecast_date", endDate.toISOString().slice(0, 10))
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    allEvents.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // ── Build daily breakdown ──
  interface DayData {
    date: string;
    // Renewals
    static_count: number;
    static_revenue: number;
    expected_count: number;
    expected_revenue: number;
    collected_count: number;
    collected_revenue: number;
    failed_count: number;
    cancelled_count: number;
    // Dunning
    dunning_count: number;
    dunning_revenue: number;
    dunning_collected_count: number;
    dunning_collected_revenue: number;
    dunning_failed_count: number;
    // Paused
    paused_count: number;
    paused_revenue: number;
    // Change events grouped
    changes: Record<string, number>;
  }

  const dailyMap: Record<string, DayData> = {};

  function emptyDay(key: string): DayData {
    return {
      date: key,
      static_count: 0, static_revenue: 0,
      expected_count: 0, expected_revenue: 0,
      collected_count: 0, collected_revenue: 0,
      failed_count: 0, cancelled_count: 0,
      dunning_count: 0, dunning_revenue: 0,
      dunning_collected_count: 0, dunning_collected_revenue: 0,
      dunning_failed_count: 0,
      paused_count: 0, paused_revenue: 0,
      changes: {},
    };
  }

  // For bounded ranges, pre-populate all days. For "all", only create on demand.
  if (range !== "all") {
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      dailyMap[key] = emptyDay(key);
    }
  }

  // Populate from forecasts
  for (const f of allForecasts) {
    if (!dailyMap[f.expected_date]) {
      if (range === "all") dailyMap[f.expected_date] = emptyDay(f.expected_date);
      else continue;
    }
    const day = dailyMap[f.expected_date];

    const rev = f.expected_revenue_cents || 0;

    // Static = ALL forecasts regardless of type (total initial expectation)
    day.static_count++;
    day.static_revenue += rev;

    if (f.forecast_type === "dunning") {
      day.dunning_count++;
      day.dunning_revenue += rev;
      if (f.status === "collected") {
        day.dunning_collected_count++;
        day.dunning_collected_revenue += f.actual_revenue_cents || 0;
      } else if (f.status === "failed") {
        day.dunning_failed_count++;
      }
    } else if (f.forecast_type === "paused") {
      day.paused_count++;
      day.paused_revenue += rev;
    } else {
      // Renewal
      if (f.status === "pending") {
        day.expected_count++;
        day.expected_revenue += rev;
      } else if (f.status === "collected") {
        day.expected_count++; // Was expected
        day.expected_revenue += rev;
        day.collected_count++;
        day.collected_revenue += f.actual_revenue_cents || 0;
      } else if (f.status === "failed") {
        day.expected_count++;
        day.expected_revenue += rev;
        day.failed_count++;
      } else if (f.status === "cancelled") {
        day.cancelled_count++;
        // Not in expected — was removed
      } else if (f.status === "paused") {
        // Not in expected — was paused
      }
    }
  }

  // Populate change events
  for (const e of allEvents) {
    if (!dailyMap[e.forecast_date]) {
      if (range === "all") dailyMap[e.forecast_date] = emptyDay(e.forecast_date);
      else continue;
    }
    const day = dailyMap[e.forecast_date];
    const type = e.event_type || "other";
    day.changes[type] = (day.changes[type] || 0) + (e.delta_cents || 0);
  }

  // Convert to array
  const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // ── Summary totals ──
  const totals = daily.reduce((acc, d) => ({
    static_revenue: acc.static_revenue + d.static_revenue,
    static_count: acc.static_count + d.static_count,
    expected_revenue: acc.expected_revenue + d.expected_revenue,
    expected_count: acc.expected_count + d.expected_count,
    collected_revenue: acc.collected_revenue + d.collected_revenue,
    collected_count: acc.collected_count + d.collected_count,
    failed_count: acc.failed_count + d.failed_count,
    cancelled_count: acc.cancelled_count + d.cancelled_count,
    dunning_revenue: acc.dunning_revenue + d.dunning_revenue,
    dunning_count: acc.dunning_count + d.dunning_count,
    dunning_collected_revenue: acc.dunning_collected_revenue + d.dunning_collected_revenue,
    dunning_collected_count: acc.dunning_collected_count + d.dunning_collected_count,
    dunning_failed_count: acc.dunning_failed_count + d.dunning_failed_count,
    paused_revenue: acc.paused_revenue + d.paused_revenue,
    paused_count: acc.paused_count + d.paused_count,
  }), {
    static_revenue: 0, static_count: 0,
    expected_revenue: 0, expected_count: 0,
    collected_revenue: 0, collected_count: 0,
    failed_count: 0, cancelled_count: 0,
    dunning_revenue: 0, dunning_count: 0,
    dunning_collected_revenue: 0, dunning_collected_count: 0,
    dunning_failed_count: 0,
    paused_revenue: 0, paused_count: 0,
  });

  // ── Aggregate change events across all days ──
  const changesSummary: Record<string, number> = {};
  for (const d of daily) {
    for (const [type, delta] of Object.entries(d.changes)) {
      changesSummary[type] = (changesSummary[type] || 0) + delta;
    }
  }

  return NextResponse.json({
    daily,
    totals,
    changes: changesSummary,
    range,
    days,
  });
}
