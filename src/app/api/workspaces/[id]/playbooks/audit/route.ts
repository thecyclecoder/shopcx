/**
 * GET /api/workspaces/[id]/playbooks/audit
 *
 * Per-playbook analytics rollup for /dashboard/settings/playbooks/audit
 * (playbook-compiler-loop § Phase 2 — existing-playbook audit surface).
 *
 * Emits one row per ACTIVE playbook with:
 *   - total_runs   — count of tickets that engaged this playbook in the last 30d
 *                    (via `tickets.active_playbook_id`; a re-engaged ticket
 *                    counts once, matching the CS director's "distinct-ticket
 *                    coverage" framing).
 *   - escalated_runs / escalation_rate — subset of total_runs where the ticket
 *                    was escalated (`tickets.escalated_at IS NOT NULL`).
 *                    The audit page renders a warn indicator when
 *                    `escalation_rate >= 0.30` (the "escalation-rate 30%
 *                    threshold" the spec-test asserts on).
 *   - low_value_share — share of `ticket_resolution_events.verified_outcome
 *                    ='drifted'` turns on those tickets — the "low-value
 *                    option share" the spec calls for.
 *   - avg_turns    — average `ticket_resolution_events` count per engaged
 *                    ticket — the "avg AI-turns-per-run" column.
 *
 * Read paths mirror the analytics rollup pattern the spec cites
 * (docs/brain/dashboard/tickets__escalated) — plain reads over the
 * write-ahead ledger, no exotic joins.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const WINDOW_DAYS = 30;

interface AuditRow {
  id: string;
  name: string;
  total_runs: number;
  escalated_runs: number;
  escalation_rate: number;
  low_value_share: number;
  avg_turns: number;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Only surface ACTIVE playbooks in the audit — retired ones live under the
  // 'Retired' subsection on /dashboard/settings/playbooks and are not
  // candidates for further audit action.
  const { data: playbooks } = await admin
    .from("playbooks")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .order("priority", { ascending: false });

  const rows: AuditRow[] = [];

  for (const pb of playbooks || []) {
    // Tickets engaged with this playbook in-window (distinct-ticket coverage).
    const { data: tickets } = await admin
      .from("tickets")
      .select("id, escalated_at, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("active_playbook_id", pb.id)
      .gte("updated_at", windowStart);

    const ticketIds = (tickets || []).map((t) => t.id as string);
    const totalRuns = ticketIds.length;
    const escalatedRuns = (tickets || []).filter((t) => (t as { escalated_at?: string | null }).escalated_at).length;
    const escalationRate = totalRuns > 0 ? escalatedRuns / totalRuns : 0;

    let turnsCount = 0;
    let driftedCount = 0;

    if (ticketIds.length > 0) {
      const { data: events } = await admin
        .from("ticket_resolution_events")
        .select("verified_outcome, ticket_id")
        .eq("workspace_id", workspaceId)
        .in("ticket_id", ticketIds);

      for (const e of events || []) {
        turnsCount++;
        if ((e as { verified_outcome?: string | null }).verified_outcome === "drifted") driftedCount++;
      }
    }

    const lowValueShare = turnsCount > 0 ? driftedCount / turnsCount : 0;
    const avgTurns = totalRuns > 0 ? turnsCount / totalRuns : 0;

    rows.push({
      id: pb.id as string,
      name: pb.name as string,
      total_runs: totalRuns,
      escalated_runs: escalatedRuns,
      escalation_rate: escalationRate,
      low_value_share: lowValueShare,
      avg_turns: avgTurns,
    });
  }

  return NextResponse.json({ rows, window_days: WINDOW_DAYS });
}
