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
  const [
    cyclesRes,
    failuresRes,
    errorCodesRes,
    terminalCancelsRes,
    recentFailuresRes,
  ] = await Promise.all([
    // Active dunning cycles by status
    admin.from("dunning_cycles")
      .select("status, terminal_error_code")
      .eq("workspace_id", workspaceId),

    // All payment failures for error code distribution (last 90 days)
    admin.from("payment_failures")
      .select("error_code, error_message, attempt_type, succeeded, created_at")
      .eq("workspace_id", workspaceId)
      .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(2000),

    // Error code classifications
    admin.from("dunning_error_codes")
      .select("error_code, is_terminal, occurrence_count, last_seen_at")
      .eq("workspace_id", workspaceId),

    // Terminal cancellations (exhausted cycles with terminal_error_code)
    admin.from("dunning_cycles")
      .select("id, shopify_contract_id, customer_id, terminal_error_code, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "exhausted")
      .not("terminal_error_code", "is", null)
      .order("created_at", { ascending: false })
      .limit(100),

    // Recent failures with customer info (last 30 days)
    admin.from("payment_failures")
      .select("id, shopify_contract_id, error_code, error_message, attempt_type, succeeded, payment_method_last4, created_at")
      .eq("workspace_id", workspaceId)
      .eq("attempt_type", "initial")
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  // Aggregate cycle statuses
  const cycles = cyclesRes.data || [];
  const cycleStats = {
    active: cycles.filter(c => ["active", "rotating"].includes(c.status)).length,
    retrying: cycles.filter(c => c.status === "retrying").length,
    skipped: cycles.filter(c => c.status === "skipped").length,
    recovered: cycles.filter(c => c.status === "recovered").length,
    exhausted: cycles.filter(c => c.status === "exhausted").length,
    terminal: cycles.filter(c => c.status === "exhausted" && c.terminal_error_code).length,
    total: cycles.length,
  };

  // Aggregate error codes from initial failures
  const failures = failuresRes.data || [];
  const initialFailures = failures.filter(f => f.attempt_type === "initial" && !f.succeeded);
  const errorCodeCounts: Record<string, { count: number; error_message: string | null }> = {};
  for (const f of initialFailures) {
    const code = f.error_code || "unknown";
    if (!errorCodeCounts[code]) errorCodeCounts[code] = { count: 0, error_message: f.error_message };
    errorCodeCounts[code].count++;
  }

  // Build error code distribution with terminal flag
  const errorCodeMap = new Map((errorCodesRes.data || []).map(c => [c.error_code, c]));
  const errorCodeDistribution = Object.entries(errorCodeCounts)
    .map(([code, { count, error_message }]) => ({
      error_code: code,
      error_message,
      count,
      is_terminal: errorCodeMap.get(code)?.is_terminal || false,
    }))
    .sort((a, b) => b.count - a.count);

  // Daily failure counts (last 30 days) — bucket by US Central date
  const centralDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // en-CA = YYYY-MM-DD
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const dailyCounts: Record<string, { failures: number }> = {};
  for (const f of initialFailures) {
    const ts = new Date(f.created_at).getTime();
    if (ts < thirtyDaysAgo) continue;
    const date = centralDate(new Date(f.created_at));
    if (!dailyCounts[date]) dailyCounts[date] = { failures: 0 };
    dailyCounts[date].failures++;
  }

  const dailyData = Object.entries(dailyCounts)
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Recovery rate
  const totalCompleted = cycleStats.recovered + cycleStats.exhausted;
  const recoveryRate = totalCompleted > 0 ? Math.round((cycleStats.recovered / totalCompleted) * 100) : 0;

  return NextResponse.json({
    cycleStats,
    errorCodeDistribution,
    dailyData,
    terminalCancels: terminalCancelsRes.data || [],
    recentFailures: recentFailuresRes.data || [],
    recoveryRate,
    totalInitialFailures: initialFailures.length,
  });
}
