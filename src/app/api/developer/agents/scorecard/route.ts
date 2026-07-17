/**
 * GET /api/developer/agents/scorecard — the Platform Department Scorecard read API
 * ([[../specs/platform-scorecard-surface]] Phase 1; milestone (d) of the
 * [[../goals/platform-department-scorecard]] goal).
 *
 * Owner-gated, read-only. Reads ONLY `platform_scorecard_snapshots` (the
 * "read from the scorecard, never the raw tables" invariant from
 * [[../libraries/meta__scorecards]] / [[../tables/platform_scorecard_snapshots]]) —
 * the surface can never drift from the persisted, trended truth.
 *
 * Two modes:
 *   - default                           → `{ daily, weekly, monthly }` the latest snapshot per
 *                                         `(metric_key, cadence)` with `value`, `prior_value`,
 *                                         `delta_pct`, `unit`, `window_days`, `snapshot_date`, `detail`.
 *   - `?metric=KEY&cadence=daily|weekly|monthly`
 *                                       → that metric's `history` (sparkline series, chronological).
 *
 * Mirrors every other [[../dashboard/agents]] API — owner-gated, force-dynamic.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";


type Cadence = "daily" | "weekly" | "monthly";
const CADENCES: Cadence[] = ["daily", "weekly", "monthly"];

interface SnapshotRow {
  metric_key: string;
  cadence: Cadence;
  snapshot_date: string;
  window_days: number;
  value: number | string;
  prior_value: number | string | null;
  delta_pct: number | string | null;
  unit: string;
  detail: Record<string, unknown> | null;
}

function toNumber(n: number | string | null | undefined): number | null {
  if (n == null) return null;
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : null;
}

/**
 * Weekly-Sunday reader guard. Under the post-fix weekly writer
 * ([[../specs/devops-kpi-weekly-snapshot-date-lag-fix]]) every valid weekly `snapshot_date` is the
 * previous ISO Sunday — any other day-of-week is a pre-fix stale in-flight row that must be
 * discarded before picking "latest" (a stale Monday 2026-06-29 row was outsorting the valid Sunday
 * 2026-06-28 row on the CEO's Approvals-untouched tile). Clears loop signature
 * `loop:kpi_drift:approvals_untouched_pct:weekly`.
 */
const isSundayUtc = (snapshotDate: string): boolean =>
  new Date(snapshotDate + "T00:00:00Z").getUTCDay() === 0;

export async function GET(req: Request) {
  const { user } = await getAuthedUser();
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
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view the Platform scorecard" }, { status: 403 });
  }

  const url = new URL(req.url);
  const metric = url.searchParams.get("metric");
  const cadenceParam = url.searchParams.get("cadence") as Cadence | null;

  // History mode — the trend sparkline series for one (metric, cadence). Chronological (oldest → newest).
  if (metric) {
    const cadence: Cadence = cadenceParam && CADENCES.includes(cadenceParam) ? cadenceParam : "daily";
    const { data, error } = await admin
      .from("platform_scorecard_snapshots")
      .select("snapshot_date, value, prior_value, delta_pct, unit, window_days, detail")
      .eq("workspace_id", workspaceId)
      .eq("metric_key", metric)
      .eq("cadence", cadence)
      .order("snapshot_date", { ascending: false })
      .limit(60);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    let rows = (data ?? []) as Array<Omit<SnapshotRow, "metric_key" | "cadence">>;
    // Weekly-Sunday reader guard — see `isSundayUtc` above. Discards pre-lag-fix stale
    // non-Sunday snapshot_dates from the history sparkline so it can't render a spike from
    // a mid-day in-flight row.
    if (cadence === "weekly") rows = rows.filter((r) => isSundayUtc(r.snapshot_date));
    const history = rows
      .map((r) => ({
        snapshot_date: r.snapshot_date,
        value: toNumber(r.value) ?? 0,
        prior_value: toNumber(r.prior_value),
        delta_pct: toNumber(r.delta_pct),
        window_days: r.window_days,
        unit: r.unit,
        detail: r.detail ?? {},
      }))
      .reverse();
    return NextResponse.json({ metric, cadence, history });
  }

  // Default mode — every cadence's LATEST snapshot per metric, grouped → { daily, weekly, monthly }.
  const { data, error } = await admin
    .from("platform_scorecard_snapshots")
    .select("metric_key, cadence, snapshot_date, window_days, value, prior_value, delta_pct, unit, detail")
    .eq("workspace_id", workspaceId)
    .order("snapshot_date", { ascending: false })
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as SnapshotRow[];
  // Per (metric_key, cadence) — first row wins (already sorted snapshot_date desc).
  const seen = new Set<string>();
  const grouped: Record<Cadence, Array<{
    metric_key: string;
    snapshot_date: string;
    window_days: number;
    value: number;
    prior_value: number | null;
    delta_pct: number | null;
    unit: string;
    detail: Record<string, unknown>;
  }>> = { daily: [], weekly: [], monthly: [] };
  for (const r of rows) {
    if (!CADENCES.includes(r.cadence)) continue;
    // Weekly-Sunday reader guard — see `isSundayUtc` above. A stale pre-lag-fix Monday row
    // would otherwise outsort the valid Sunday row and stick the wrong value onto the CEO's
    // tile until the next weekly write supersedes it.
    if (r.cadence === "weekly" && !isSundayUtc(r.snapshot_date)) continue;
    const k = `${r.cadence}::${r.metric_key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    grouped[r.cadence].push({
      metric_key: r.metric_key,
      snapshot_date: r.snapshot_date,
      window_days: r.window_days,
      value: toNumber(r.value) ?? 0,
      prior_value: toNumber(r.prior_value),
      delta_pct: toNumber(r.delta_pct),
      unit: r.unit,
      detail: (r.detail ?? {}) as Record<string, unknown>,
    });
  }

  return NextResponse.json(grouped);
}
