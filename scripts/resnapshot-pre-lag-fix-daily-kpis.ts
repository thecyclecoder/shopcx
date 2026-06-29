/**
 * resnapshot-pre-lag-fix-daily-kpis — one-off cleanup for the stranded daily
 * platform_scorecard_snapshots rows written BEFORE devops-kpi-daily-snapshot-date-lag-fix landed
 * (docs/brain/specs/devops-kpi-snapshot-guard-stale-row-fix.md Phase 1; verdict: real-bug;
 * repair-signature: loop:kpi_drift:autonomy_ratio:daily).
 *
 * THE PROBLEM. Before the lag-fix (commit 232f6ad8, 2026-06-28 12:11 UTC), the daily cron stamped
 * each snapshot with `snapshot_date = today UTC` and computed the metric values over the
 * `[today, today]` window — i.e. against an IN-FLIGHT day (only the hours elapsed up to the cron
 * tick had landed in the source tables). The persisted value captured a partial-day reading.
 *
 * The lag-fix then made the cron stamp `snapshot_date = yesterday UTC` over the full closed day.
 * Going forward, every new daily row reflects a complete 24h window.
 *
 * BUT the audit pass (audit-platform-scorecard step on platform-director-cron, devops-kpi-review-
 * sdk-and-data-fix Phase 5) re-derives each closed daily snapshot using the SAME window math
 * (`[snapshot_date, snapshot_date]`). For the pre-lag-fix rows, the day is now closed — the
 * re-derived "ground truth" is the FULL day's count, which differs from the persisted partial-day
 * reading. The audit logs drift; ≥2 consecutive over-tolerance audits open
 * `loop_alerts.signature = kpi_drift:autonomy_ratio:daily` (and other metrics in the same shape).
 *
 * THE FIX. For every (workspace_id, snapshot_date) pair in platform_scorecard_snapshots where
 * cadence='daily' AND the row was written pre-lag-fix (heuristic: snapshot_date >= updated_at::date
 * UTC — pre-lag-fix wrote same-day; post-lag-fix lags by one day so snapshot_date < updated_at::date)
 * AND the day is closed (snapshot_date < today UTC), re-run computePlatformScorecard with that
 * (cadence='daily', windowDays=1, snapshotDate). The upsert key
 * (workspace_id, metric_key, cadence, snapshot_date) overwrites every metric row in place against
 * the now-complete day's data. Subsequent audits then find the rows within tolerance and the
 * `kpi_drift:autonomy_ratio:daily` loop_alert auto-resolves on the next audit pass.
 *
 * The recompute is idempotent — a post-lag-fix daily row re-run by this script would re-upsert the
 * byte-equivalent value the engine already wrote. The structural filter (`snapshot_date >=
 * updated_at::date`) keeps us off them anyway.
 *
 * Usage:
 *   npx tsx scripts/resnapshot-pre-lag-fix-daily-kpis.ts                 # dry-run, all workspaces
 *   npx tsx scripts/resnapshot-pre-lag-fix-daily-kpis.ts --apply         # write
 *   npx tsx scripts/resnapshot-pre-lag-fix-daily-kpis.ts <workspace-id>  # narrow to one ws (dry-run)
 *   npx tsx scripts/resnapshot-pre-lag-fix-daily-kpis.ts <workspace-id> --apply
 */
import { createAdminClient } from "./_bootstrap";
import { computePlatformScorecard } from "../src/lib/agents/platform-scorecard";

interface PersistedRow {
  workspace_id: string;
  metric_key: string;
  snapshot_date: string;
  value: number;
  updated_at: string;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const workspaceArg = argv.find((a) => !a.startsWith("--"));
  const admin = createAdminClient();

  const todayUtc = new Date().toISOString().slice(0, 10);

  // Pull every closed-day daily row (snapshot_date < today UTC). We filter the pre-lag-fix shape
  // (snapshot_date >= updated_at::date UTC) client-side — Postgres date casts inside a PostgREST
  // filter are awkward and this set is small (one row per workspace × metric × day, with daily
  // KPI snapshots only running for a few weeks at most).
  const baseQuery = admin
    .from("platform_scorecard_snapshots")
    .select("workspace_id, metric_key, snapshot_date, value, updated_at")
    .eq("cadence", "daily")
    .lt("snapshot_date", todayUtc);

  const { data, error } = workspaceArg
    ? await baseQuery.eq("workspace_id", workspaceArg)
    : await baseQuery;
  if (error) {
    console.error(`platform_scorecard_snapshots read failed: ${error.message}`);
    process.exit(1);
  }

  const rows = ((data ?? []) as PersistedRow[]).filter(
    (r) => r.snapshot_date >= r.updated_at.slice(0, 10),
  );

  if (!rows.length) {
    console.log(
      `No stranded pre-lag-fix daily rows found (todayUTC=${todayUtc}${workspaceArg ? `, ws=${workspaceArg}` : ""}).`,
    );
    return;
  }

  // Group by (workspace_id, snapshot_date) — one re-snapshot call per pair recomputes the whole
  // metric registry for that day.
  const byPair = new Map<string, { workspaceId: string; snapshotDate: string; metrics: PersistedRow[] }>();
  for (const r of rows) {
    const key = `${r.workspace_id}|${r.snapshot_date}`;
    let bucket = byPair.get(key);
    if (!bucket) {
      bucket = { workspaceId: r.workspace_id, snapshotDate: r.snapshot_date, metrics: [] };
      byPair.set(key, bucket);
    }
    bucket.metrics.push(r);
  }

  console.log(
    `${apply ? "APPLY" : "DRY-RUN"}: ${byPair.size} stranded (workspace × day) pair(s) covering ${rows.length} metric row(s). todayUTC=${todayUtc}.`,
  );

  let pairsTouched = 0;
  let metricsRewritten = 0;
  for (const { workspaceId, snapshotDate, metrics } of byPair.values()) {
    console.log(`\n— ws=${workspaceId} snapshot_date=${snapshotDate} (${metrics.length} metric row(s) on file)`);
    if (apply) {
      try {
        const written = await computePlatformScorecard(workspaceId, {
          cadence: "daily",
          windowDays: 1,
          snapshotDate,
        });
        pairsTouched++;
        metricsRewritten += written.length;
        const beforeByKey = new Map(metrics.map((m) => [m.metric_key, m.value]));
        for (const w of written) {
          const before = beforeByKey.get(w.metric_key);
          const beforeTxt = before == null ? "(new)" : String(before);
          console.log(`    ${w.metric_key}: ${beforeTxt} → ${w.value}`);
        }
      } catch (e) {
        console.error(`    ERROR re-snapshotting: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      for (const m of metrics) {
        console.log(`    ${m.metric_key}: current=${m.value} (updated_at=${m.updated_at})`);
      }
    }
  }

  console.log(
    apply
      ? `\nDone. Re-snapshotted ${pairsTouched}/${byPair.size} pair(s); wrote ${metricsRewritten} metric row(s). The next audit-platform-scorecard pass on platform-director-cron will re-check drift and auto-resolve the kpi_drift:*:daily loop_alerts.`
      : `\nDry-run only. Re-run with --apply to overwrite the stranded rows.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
