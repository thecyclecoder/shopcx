/**
 * _probe-mario-accuracy — print Mario's trigger-accuracy stats for a workspace over the
 * last N days (default 7). Phase 4 of mario-reactive-box-agent.
 *
 * Reads `director_activity` rows where `action_kind='mario_fired'` and computes the
 * `accuracy_pct` = `trigger_accurate_count / (trigger_accurate_count + trigger_inaccurate_count)`
 * — the same shape the pipeline-health dashboard's MarioAccuracyCard consumes.
 *
 * Read-only. No mutation.
 *
 * Usage:
 *   npx tsx scripts/_probe-mario-accuracy.ts <workspace_id> [window_days]
 *   npx tsx scripts/_probe-mario-accuracy.ts fdc11e10-b89f-4989-8b73-ed6526c4d906 7
 */
import { createAdminClient } from "./_bootstrap";
import { readMarioAccuracy, readMarioWidenedThresholds } from "../src/lib/mario";

async function main() {
  const workspaceId = process.argv[2];
  const windowDays = Number.parseInt(process.argv[3] ?? "7", 10);
  if (!workspaceId) {
    console.error("usage: npx tsx scripts/_probe-mario-accuracy.ts <workspace_id> [window_days]");
    process.exit(2);
  }
  const admin = createAdminClient();
  const stats = await readMarioAccuracy(admin, workspaceId, Number.isFinite(windowDays) ? windowDays : 7);
  console.log(`mario accuracy — workspace=${workspaceId} window=${stats.window_days}d`);
  console.log(`  fired_count             = ${stats.fired_count}`);
  console.log(`  trigger_accurate_count  = ${stats.trigger_accurate_count}`);
  console.log(`  trigger_inaccurate_count= ${stats.trigger_inaccurate_count}`);
  console.log(`  accuracy_pct            = ${stats.accuracy_pct ?? "n/a (no decided fires)"}`);

  const widened = await readMarioWidenedThresholds(admin, workspaceId);
  console.log(`\nwidened thresholds (${widened.length}):`);
  for (const w of widened) {
    console.log(
      `  ${w.from_event} → ${w.to_event}  sla=${w.sla_ms}ms  widened_at=${w.last_widened_at}  reason=${w.last_widened_reason ?? ""}`,
    );
  }
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
