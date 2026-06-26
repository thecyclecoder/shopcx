/**
 * Audit every advertised Platform Department Scorecard KPI — for each workspace, print a drift table
 * comparing the persisted [[../docs/brain/tables/platform_scorecard_snapshots]] row to a same-window
 * re-run of the SAME `MetricDef.compute` from [[../docs/brain/libraries/platform-scorecard]].
 *
 * Implements the [[devops-kpi-review-sdk-and-data-fix]] Phase 1 CLI. Read-only — calls the
 * [[../docs/brain/libraries/kpi-review]] SDK which never writes.
 *
 * Usage:
 *   npx tsx scripts/_audit-kpis.ts                 # all workspaces, all three cadences
 *   npx tsx scripts/_audit-kpis.ts <workspace-id>  # narrow to one workspace
 *
 * Columns: metric · cadence · snapshot · ground-truth · drift · driftPct · status.
 */
import { createAdminClient } from "./_bootstrap";
import {
  auditAllKpis,
  type KpiAuditReport,
} from "../src/lib/agents/kpi-review";
import type { Cadence } from "../src/lib/agents/platform-scorecard";

const CADENCES: Cadence[] = ["daily", "weekly", "monthly"];

function fmt(n: number, unit: string): string {
  if (!Number.isFinite(n)) return "—";
  if (unit === "pct") return `${n.toFixed(2)}%`;
  if (unit === "ratio") return n.toFixed(4);
  if (unit === "hours") return `${n.toFixed(2)}h`;
  if (unit === "grade") return `${n.toFixed(2)}/10`;
  return Number.isInteger(n) ? n.toString() : n.toFixed(2);
}

function fmtPct(p: number | null): string {
  if (p == null) return "—";
  return `${(p * 100).toFixed(2)}%`;
}

function status(r: KpiAuditReport): string {
  if (r.withinTolerance) return "ok";
  if (r.driftPct == null) return "drift (n/a%)";
  if (r.driftPct >= 0.05) return "DRIFT";
  return "drift";
}

function printTable(rows: KpiAuditReport[]) {
  if (!rows.length) {
    console.log("  (no persisted snapshots yet — nothing to compare)");
    return;
  }
  const widths = { metric: 28, cadence: 8, snap: 14, gt: 14, drift: 14, pct: 10, status: 14 };
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
  console.log(
    pad("metric", widths.metric) +
      pad("cadence", widths.cadence) +
      pad("snapshot", widths.snap) +
      pad("ground-truth", widths.gt) +
      pad("drift", widths.drift) +
      pad("driftPct", widths.pct) +
      "status",
  );
  console.log("─".repeat(widths.metric + widths.cadence + widths.snap + widths.gt + widths.drift + widths.pct + widths.status));
  for (const r of rows) {
    console.log(
      pad(r.metric, widths.metric) +
        pad(r.cadence, widths.cadence) +
        pad(fmt(r.snapshotValue, r.unit), widths.snap) +
        pad(fmt(r.groundTruthValue, r.unit), widths.gt) +
        pad(fmt(r.drift, r.unit), widths.drift) +
        pad(fmtPct(r.driftPct), widths.pct) +
        status(r),
    );
  }
}

async function main() {
  const argWorkspace = process.argv[2];
  const admin = createAdminClient();

  let workspaceIds: string[] = [];
  if (argWorkspace) {
    workspaceIds = [argWorkspace];
  } else {
    const { data } = await admin
      .from("platform_scorecard_snapshots")
      .select("workspace_id")
      .limit(1000);
    workspaceIds = Array.from(
      new Set(((data ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id)),
    );
  }

  if (!workspaceIds.length) {
    console.log("No workspaces with persisted scorecard snapshots yet.");
    return;
  }

  let totalDrift = 0;
  for (const ws of workspaceIds) {
    console.log(`\n=== workspace ${ws} ===`);
    for (const cadence of CADENCES) {
      console.log(`\n--- ${cadence} ---`);
      const reports = await auditAllKpis(ws, cadence);
      printTable(reports);
      totalDrift += reports.filter((r) => !r.withinTolerance).length;
    }
  }
  console.log(`\nTotal metrics drifting beyond tolerance: ${totalDrift}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
