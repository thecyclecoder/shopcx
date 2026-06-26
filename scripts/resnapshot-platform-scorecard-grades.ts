// resnapshot-platform-scorecard-grades — idempotent re-snapshot for the grade-unit fix
// (docs/brain/specs/devops-kpi-review-sdk-and-data-fix.md Phase 2).
//
// Phase 2 flipped worker_grade_rollup (weekly) + director_call_grade (monthly) from unit='ratio'
// to unit='grade'. The persisted rows in platform_scorecard_snapshots still carry unit='ratio',
// so the scorecard tile would render today's grade as e.g. "850%" until the next scheduled cron
// fires. Re-running computePlatformScorecard for cadence in {weekly, monthly} upserts every row
// on (workspace_id, metric_key, cadence, snapshot_date) — same value, freshly-stamped unit='grade'.
//
// Same-day idempotent (the engine's upsert key). The migration that expands the CHECK to allow
// 'grade' (apply-platform-scorecard-unit-add-grade-migration.ts) MUST be applied first or the
// upsert is rejected.
//
// Usage:
//   npx tsx scripts/resnapshot-platform-scorecard-grades.ts                 # all workspaces
//   npx tsx scripts/resnapshot-platform-scorecard-grades.ts <workspace-id>  # narrow to one
//
// Read-then-write — only the two grade-metric rows change unit. Other metric rows are re-upserted
// in place with their existing unit (no schema effect).
import { createAdminClient } from "./_bootstrap";
import { computePlatformScorecard, type Cadence } from "../src/lib/agents/platform-scorecard";

const CADENCES: Cadence[] = ["weekly", "monthly"];

async function main() {
  const argWorkspace = process.argv[2];
  const admin = createAdminClient();

  let workspaceIds: string[];
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
    console.log("No workspaces with persisted scorecard snapshots yet — nothing to re-snapshot.");
    return;
  }

  for (const ws of workspaceIds) {
    console.log(`\n=== workspace ${ws} ===`);
    for (const cadence of CADENCES) {
      const rows = await computePlatformScorecard(ws, { cadence });
      const gradeRows = rows.filter((r) => r.unit === "grade");
      console.log(
        `  ${cadence}: re-snapshotted ${rows.length} metric(s); grade rows = ${gradeRows
          .map((r) => `${r.metric_key}=${r.value}`)
          .join(", ") || "(none)"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
