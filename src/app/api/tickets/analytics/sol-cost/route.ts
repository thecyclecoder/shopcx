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
 *     resessions: Array<{ supersede_count: number, tickets: number }>,
 *     cap_hits: {
 *       total_7d: number,
 *       per_playbook_slug: Record<string, number>,
 *       per_inflection_kind: { frustration: number, drift: number }
 *     }
 *   }
 *
 * `cap_hits` — Phase 3 of docs/brain/specs/sol-runaway-re-session-cap-guardrail.md.
 * Fixed 7-day rolling window (independent of `window_days`) over
 * `ticket_resolution_events WHERE reasoning='sol:cap-hit'`, so the "Sol cap-hits (7d)"
 * subline on the Sol economics tile has a stable time horizon regardless of the tile's
 * cost window. `per_playbook_slug` is keyed by the ticket's current `active_playbook_id`
 * (mapped to `playbooks.name`); tickets not on a playbook bucket into `"none"`.
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

  // Phase 1 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
  // The prior code fetched every window ticket + its ticket_directions rows and
  // computed the percentile / cohort split in JS — PostgREST's 1000-row cap
  // silently truncated the source set on any busy workspace. Server-side now.
  const { data: rpcRows } = await admin.rpc("analytics_sol_cost", {
    p_workspace: workspaceId,
    p_window_days: windowDays,
  });
  const agg = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as {
    overall_count: number | string | null;
    overall_median_cents: number | string | null;
    overall_p95_cents: number | string | null;
    pre_sol_count: number | string | null;
    pre_sol_median_cents: number | string | null;
    pre_sol_p95_cents: number | string | null;
    sol_count: number | string | null;
    sol_median_cents: number | string | null;
    sol_p95_cents: number | string | null;
    pre_sol_csat_count: number | string | null;
    pre_sol_csat_avg: number | string | null;
    sol_csat_count: number | string | null;
    sol_csat_avg: number | string | null;
    resessions: Array<{ supersede_count: number; tickets: number }> | null;
  } | null;

  const num = (v: number | string | null | undefined) =>
    v === null || v === undefined ? 0 : (typeof v === "string" ? Number(v) : v) || 0;
  const numOrNull = (v: number | string | null | undefined) =>
    v === null || v === undefined ? null : Number(v);

  const overallStats = {
    count: num(agg?.overall_count),
    median_cents: num(agg?.overall_median_cents),
    p95_cents: num(agg?.overall_p95_cents),
  };
  const preSolStats = {
    count: num(agg?.pre_sol_count),
    median_cents: num(agg?.pre_sol_median_cents),
    p95_cents: num(agg?.pre_sol_p95_cents),
  };
  const solStats = {
    count: num(agg?.sol_count),
    median_cents: num(agg?.sol_median_cents),
    p95_cents: num(agg?.sol_p95_cents),
  };
  const preSolCsatN = num(agg?.pre_sol_csat_count);
  const solCsatN = num(agg?.sol_csat_count);
  const preSolCsatAvg = numOrNull(agg?.pre_sol_csat_avg);
  const solCsatAvg = numOrNull(agg?.sol_csat_avg);
  const resessions = (agg?.resessions ?? []).map((r) => ({
    supersede_count: Number(r.supersede_count) || 0,
    tickets: Number(r.tickets) || 0,
  }));

  // Phase 3 of sol-runaway-re-session-cap-guardrail — cap-hit tile data.
  // Fixed 7-day window (per spec), workspace-scoped, filtered on the router-authored
  // `sol:cap-hit` sentinel.
  const capHitsSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const capHits: {
    total_7d: number;
    per_playbook_slug: Record<string, number>;
    per_inflection_kind: { frustration: number; drift: number };
  } = {
    total_7d: 0,
    per_playbook_slug: {},
    per_inflection_kind: { frustration: 0, drift: 0 },
  };
  try {
    const { data: capHitRows } = await admin
      .from("ticket_resolution_events")
      .select("ticket_id, chosen")
      .eq("workspace_id", workspaceId)
      .eq("reasoning", "sol:cap-hit")
      .gte("staged_at", capHitsSince);
    const rows = (capHitRows ?? []) as Array<{
      ticket_id: string;
      chosen: Record<string, unknown> | null;
    }>;
    capHits.total_7d = rows.length;

    // Resolve each cap-hit ticket's current active_playbook_id → playbooks.name for the
    // per_playbook_slug bucket. Tickets not on a playbook (or with a stale/missing playbook)
    // bucket into "none". Deduped by ticket_id so we make a single lookup per unique ticket.
    const uniqueTicketIds = Array.from(new Set(rows.map((r) => r.ticket_id)));
    const playbookByTicket = new Map<string, string>();
    if (uniqueTicketIds.length > 0) {
      const { data: tks } = await admin
        .from("tickets")
        .select("id, active_playbook_id")
        .eq("workspace_id", workspaceId)
        .in("id", uniqueTicketIds);
      const tkRows = (tks ?? []) as Array<{ id: string; active_playbook_id: string | null }>;
      const activePbIds = Array.from(
        new Set(
          tkRows
            .map((t) => t.active_playbook_id)
            .filter((v): v is string => typeof v === "string"),
        ),
      );
      const nameByPbId = new Map<string, string>();
      if (activePbIds.length > 0) {
        const { data: pbs } = await admin
          .from("playbooks")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .in("id", activePbIds);
        for (const p of ((pbs ?? []) as Array<{ id: string; name: string | null }>)) {
          if (typeof p.name === "string" && p.name.length > 0) nameByPbId.set(p.id, p.name);
        }
      }
      for (const t of tkRows) {
        const name = t.active_playbook_id ? (nameByPbId.get(t.active_playbook_id) ?? "none") : "none";
        playbookByTicket.set(t.id, name);
      }
    }
    for (const r of rows) {
      const slug = playbookByTicket.get(r.ticket_id) ?? "none";
      capHits.per_playbook_slug[slug] = (capHits.per_playbook_slug[slug] ?? 0) + 1;
      const kindRaw = (r.chosen ?? {})["kind"];
      const kind = kindRaw === "frustration" || kindRaw === "drift" ? kindRaw : null;
      if (kind === "frustration") capHits.per_inflection_kind.frustration += 1;
      else if (kind === "drift") capHits.per_inflection_kind.drift += 1;
    }
  } catch {
    // ticket_resolution_events might be temporarily unavailable — the tile renders zeros
    // rather than 500'ing the whole analytics page.
  }

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
      overall: overallStats,
      pre_sol: preSolStats,
      sol: solStats,
    },
    csat: {
      pre_sol: {
        count: preSolCsatN,
        avg: preSolCsatN > 0 ? preSolCsatAvg : null,
      },
      sol: {
        count: solCsatN,
        avg: solCsatN > 0 ? solCsatAvg : null,
      },
    },
    resessions,
    cap_hits: capHits,
  });
}
