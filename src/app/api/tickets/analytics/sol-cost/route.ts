/**
 * /api/tickets/analytics/sol-cost — Sol economics tile data.
 *
 * Phase 3 of docs/brain/specs/sol-cost-csat-measurement-vs-pre-sol-baseline.md.
 * Read-only. Owner/admin/cs_manager only.
 *
 * Computes:
 *   - median + p95 of tickets.ai_cost_cents over the window (default 30d)
 *   - split cohort by "has any ticket_directions row": pre_sol=no, sol=yes
 *   - avg tickets.csat_score per cohort
 *   - re-session histogram: count of tickets by their live-Direction supersede
 *     count (tickets grouped by ticket_directions rows per ticket where
 *     superseded_at IS NOT NULL)
 *   - catherine_baseline_cents pinned at 892 (the M5 reference price)
 *   - shadow_baseline_cents: median from the latest public.sol_replay_runs
 *     row (Phase 4) when one exists — null pre-replay.
 *
 * Response shape:
 *   {
 *     window_days: 30,
 *     catherine_baseline_cents: 892,
 *     shadow_baseline_cents: number | null,
 *     cost: {
 *       overall: { count, median_cents, p95_cents },
 *       pre_sol: { count, median_cents, p95_cents },
 *       sol:     { count, median_cents, p95_cents }
 *     },
 *     csat: {
 *       pre_sol: { count, avg: number | null },
 *       sol:     { count, avg: number | null }
 *     },
 *     resessions: Array<{ supersede_count: number, tickets: number }>
 *   }
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ALLOWED_ROLES = ["owner", "admin", "cs_manager"];
const CATHERINE_BASELINE_CENTS = 892;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function costStats(values: number[]): { count: number; median_cents: number; p95_cents: number } {
  if (values.length === 0) return { count: 0, median_cents: 0, p95_cents: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median_cents: percentile(sorted, 0.5),
    p95_cents: percentile(sorted, 0.95),
  };
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !ALLOWED_ROLES.includes(member.role)) {
    return NextResponse.json({ error: "Owner, admin, or CS manager role required" }, { status: 403 });
  }

  const url = new URL(req.url);
  const windowDaysRaw = url.searchParams.get("window_days");
  const windowDays = windowDaysRaw ? Math.max(1, Math.min(365, parseInt(windowDaysRaw, 10) || 30)) : 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Tickets in window with their cost + csat.
  const { data: tickets } = await admin
    .from("tickets")
    .select("id, ai_cost_cents, csat_score")
    .eq("workspace_id", workspaceId)
    .gte("created_at", since)
    .is("merged_into", null);
  const ticketRows = (tickets ?? []) as Array<{ id: string; ai_cost_cents: number | string | null; csat_score: number | null }>;

  const ticketIds = ticketRows.map((t) => t.id);
  // Which of these tickets have at least one ticket_directions row?
  // Also fetch supersede-count histogram: count rows per ticket where superseded_at IS NOT NULL.
  const directionsByTicket = new Map<string, { hasAny: boolean; supersededCount: number }>();
  if (ticketIds.length > 0) {
    const { data: dirRows } = await admin
      .from("ticket_directions")
      .select("ticket_id, superseded_at")
      .eq("workspace_id", workspaceId)
      .in("ticket_id", ticketIds);
    for (const row of (dirRows ?? []) as Array<{ ticket_id: string; superseded_at: string | null }>) {
      const entry = directionsByTicket.get(row.ticket_id) ?? { hasAny: false, supersededCount: 0 };
      entry.hasAny = true;
      if (row.superseded_at !== null) entry.supersededCount += 1;
      directionsByTicket.set(row.ticket_id, entry);
    }
  }

  const preSolCosts: number[] = [];
  const solCosts: number[] = [];
  const allCosts: number[] = [];
  let preSolCsatSum = 0, preSolCsatN = 0;
  let solCsatSum = 0, solCsatN = 0;
  const resessionHistogram = new Map<number, number>();

  for (const t of ticketRows) {
    const cents = Number(t.ai_cost_cents ?? 0) || 0;
    allCosts.push(cents);
    const dir = directionsByTicket.get(t.id);
    const isSol = !!dir?.hasAny;
    if (isSol) {
      solCosts.push(cents);
      if (t.csat_score !== null && Number.isFinite(t.csat_score)) {
        solCsatSum += t.csat_score;
        solCsatN += 1;
      }
      const bucket = dir?.supersededCount ?? 0;
      resessionHistogram.set(bucket, (resessionHistogram.get(bucket) ?? 0) + 1);
    } else {
      preSolCosts.push(cents);
      if (t.csat_score !== null && Number.isFinite(t.csat_score)) {
        preSolCsatSum += t.csat_score;
        preSolCsatN += 1;
      }
    }
  }

  const resessions = [...resessionHistogram.entries()]
    .map(([supersede_count, tickets]) => ({ supersede_count, tickets }))
    .sort((a, b) => a.supersede_count - b.supersede_count);

  // Phase 4: latest sol_replay_runs median as the shadow baseline. Null when
  // no replay has run yet or the table doesn't exist (pre-migration).
  let shadowBaselineCents: number | null = null;
  try {
    const { data: latest } = await admin
      .from("sol_replay_runs")
      .select("results, total_estimated_cents, sample_size")
      .eq("workspace_id", workspaceId)
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest) {
      const rowResults = (latest as { results: unknown }).results;
      if (Array.isArray(rowResults) && rowResults.length > 0) {
        const per = rowResults
          .map((r) => (r && typeof r === "object" ? Number((r as { estimated_cents?: unknown }).estimated_cents ?? 0) : 0))
          .filter((n) => Number.isFinite(n));
        if (per.length > 0) {
          shadowBaselineCents = percentile([...per].sort((a, b) => a - b), 0.5);
        }
      }
      if (shadowBaselineCents === null) {
        const total = Number((latest as { total_estimated_cents: number | null }).total_estimated_cents ?? 0);
        const size = Number((latest as { sample_size: number | null }).sample_size ?? 0);
        if (size > 0) shadowBaselineCents = Math.round(total / size);
      }
    }
  } catch {
    // sol_replay_runs may not exist yet — Phase 4 migration lands the table.
    // Tile renders shadow_baseline_cents: null in that case.
    shadowBaselineCents = null;
  }

  return NextResponse.json({
    window_days: windowDays,
    catherine_baseline_cents: CATHERINE_BASELINE_CENTS,
    shadow_baseline_cents: shadowBaselineCents,
    cost: {
      overall: costStats(allCosts),
      pre_sol: costStats(preSolCosts),
      sol: costStats(solCosts),
    },
    csat: {
      pre_sol: {
        count: preSolCsatN,
        avg: preSolCsatN > 0 ? preSolCsatSum / preSolCsatN : null,
      },
      sol: {
        count: solCsatN,
        avg: solCsatN > 0 ? solCsatSum / solCsatN : null,
      },
    },
    resessions,
  });
}
