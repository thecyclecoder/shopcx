/**
 * control-tower-monitor cron — the Control Tower watchdog (control-tower spec, Phase 1).
 *
 * Every ~15 min it evaluates every registered loop (src/lib/control-tower/registry.ts)
 * for LIVENESS (box worker), CRON FRESHNESS, and STUCK JOBS, then opens a de-duped
 * alert per red loop (paging the owners via the Slack ops path on first sight) and
 * auto-resolves an open alert the moment its loop goes healthy. All the logic lives
 * in src/lib/control-tower/monitor.ts (shared read-only snapshot with the dashboard).
 *
 * This cron is itself a monitored loop — it emits its own heartbeat at the end so a
 * dead watchdog is visible too (a freshness gap on 'control-tower-monitor').
 * See docs/brain/inngest/control-tower-monitor.md.
 */
import { inngest } from "@/lib/inngest/client";
import { runControlTowerMonitor } from "@/lib/control-tower/monitor";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { MONITOR_TICK_FLOOR_MS } from "@/lib/control-tower/registry";

// Cron cadence derived from MONITOR_TICK_FLOOR_MS (monitor-cadence-scaled-liveness-window Phase 1) —
// the smallest cadence the registry accepts. Matches the `control-tower-monitor` MONITORED_LOOPS entry.
const MONITOR_CRON_EXPR = `*/${Math.round(MONITOR_TICK_FLOOR_MS / 60_000)} * * * *`;

export const controlTowerMonitor = inngest.createFunction(
  {
    id: "control-tower-monitor",
    name: "Control Tower — liveness + alerting watchdog",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: MONITOR_CRON_EXPR }],
  },
  async ({ step }) => {
    const startedAt = Date.now();
    const result = await step.run("evaluate-loops", async () => runControlTowerMonitor());

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("control-tower-monitor", {
        ok: true,
        produced: result,
        detail: `${result.red} red · ${result.amber} amber · ${result.green} green · opened ${result.opened} · resolved ${result.resolved}`,
        durationMs: Date.now() - startedAt,
      });
    });

    return result;
  },
);
