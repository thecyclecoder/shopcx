/**
 * mario-stall-cron — Mario's M3 detector tick (docs/brain/specs/spec-mario-stall-detector-cron-and-thresholds.md).
 *
 * Every minute: iterate workspaces, call [[../mario]] `evaluateStalledSpecs` per workspace,
 * and for every surviving candidate call `enqueueMarioJob` (dedupe-guarded so a spec_slug
 * can't have two live mario jobs at once). Bounded per-tick cap (25 enqueues by default)
 * so a massive backlog doesn't overwhelm the mario lane.
 *
 * The evaluator is deterministic (spec_timecards + mario_thresholds + spec-blockers reads)
 * and the enqueue is idempotent, so a retry / a double-fire is safe. Runs in the Vercel /
 * Inngest runtime alongside deploy-guardian-cron; no box token burn.
 *
 * See [[../mario]] · [[../../../docs/brain/tables/mario_thresholds]] ·
 * [[../../../docs/brain/tables/spec_timecard_events]].
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  evaluateStalledSpecs,
  enqueueMarioJob,
  readMarioAccuracy,
  readMarioAccuracyAlarmPct,
} from "@/lib/mario";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

/** Per-tick cap on enqueues — mirrors deploy-guardian-cron's bounded tick. */
const MARIO_PER_TICK_ENQUEUE_CAP = 25;

/** Window for the accuracy alarm — Phase 4. Under alarm_pct over the last day surfaces to Ada. */
const MARIO_ACCURACY_ALARM_WINDOW_DAYS = 1;

/** Minimum sample size before the alarm can fire — a single false trigger shouldn't page anyone. */
const MARIO_ACCURACY_ALARM_MIN_SAMPLE = 5;

export const marioStallCron = inngest.createFunction(
  {
    id: "mario-stall-cron",
    // The next tick re-evaluates a minute later — no value in long retries here.
    retries: 1,
    triggers: [{ cron: "*/5 * * * *" }], // every 5 min (CEO 2026-07-11 monitoring-cost guardrail: MONITOR_TICK_FLOOR_MS)
  },
  async ({ step }) => {
    const result = await step.run("evaluate-and-enqueue", async () => {
      const admin = createAdminClient();

      // Iterate every workspace. The evaluator is workspace-scoped (mario_thresholds is
      // per-workspace), so a per-workspace loop keeps the read graph small even as tenants scale.
      const { data: workspaces, error: wsErr } = await admin.from("workspaces").select("id");
      if (wsErr) throw wsErr;

      let candidatesEvaluated = 0;
      let jobsEnqueued = 0;
      let jobsDeduped = 0;
      let capReached = false;

      for (const ws of workspaces ?? []) {
        if (jobsEnqueued >= MARIO_PER_TICK_ENQUEUE_CAP) {
          capReached = true;
          break;
        }
        const candidates = await evaluateStalledSpecs(admin, ws.id);
        candidatesEvaluated += candidates.length;

        for (const candidate of candidates) {
          if (jobsEnqueued >= MARIO_PER_TICK_ENQUEUE_CAP) {
            capReached = true;
            break;
          }
          const enq = await enqueueMarioJob(admin, candidate);
          if (enq.enqueued) jobsEnqueued += 1;
          else if (enq.reason === "active_mario_exists") jobsDeduped += 1;
        }
      }

      return {
        candidates_evaluated: candidatesEvaluated,
        jobs_enqueued: jobsEnqueued,
        jobs_deduped: jobsDeduped,
        cap_reached: capReached,
      };
    });

    // Phase 4 — supervisor telemetry alarm. Per workspace, compute the last-24h accuracy_pct;
    // when accuracy_pct < MARIO_ACCURACY_ALARM_PCT (default 60) AND fired_count ≥ 5, emit ONE
    // OPEN dashboard_notifications row targeted at Ada (fallback CEO) so an under-performing
    // Mario can't silently over-fire. Deduped on metadata.dedupe_key so a stretch of red ticks
    // doesn't stack notifications — one open card per workspace at a time.
    await step.run("accuracy-alarm", async () => {
      const admin = createAdminClient();
      const alarmPct = readMarioAccuracyAlarmPct();
      const { data: workspaces } = await admin.from("workspaces").select("id");
      for (const ws of workspaces ?? []) {
        try {
          const stats = await readMarioAccuracy(admin, ws.id, MARIO_ACCURACY_ALARM_WINDOW_DAYS);
          if (
            stats.fired_count >= MARIO_ACCURACY_ALARM_MIN_SAMPLE &&
            stats.accuracy_pct !== null &&
            stats.accuracy_pct < alarmPct
          ) {
            const dedupeKey = `mario_accuracy_alarm:${ws.id}`;
            // Loop-guard: one OPEN alarm per workspace at a time.
            const { data: open } = await admin
              .from("dashboard_notifications")
              .select("id")
              .eq("workspace_id", ws.id)
              .eq("metadata->>dedupe_key", dedupeKey)
              .eq("dismissed", false)
              .limit(1);
            if (Array.isArray(open) && open.length > 0) continue;
            await admin.from("dashboard_notifications").insert({
              workspace_id: ws.id,
              type: "mario_accuracy_alarm",
              title: `Mario accuracy dropped to ${stats.accuracy_pct}% (< ${alarmPct}%)`,
              body:
                `Fired ${stats.fired_count} time(s) in the last ${MARIO_ACCURACY_ALARM_WINDOW_DAYS}d; ` +
                `${stats.trigger_accurate_count} accurate, ${stats.trigger_inaccurate_count} inaccurate. ` +
                `Investigate + revert widened thresholds on the pipeline-health dashboard, or tune ` +
                `MARIO_ACCURACY_ALARM_PCT / MARIO_LOOP_GUARD_MAX.`,
              link: "/dashboard/pipeline-health",
              metadata: {
                dedupe_key: dedupeKey,
                accuracy_pct: stats.accuracy_pct,
                alarm_pct: alarmPct,
                fired_count: stats.fired_count,
                trigger_accurate_count: stats.trigger_accurate_count,
                trigger_inaccurate_count: stats.trigger_inaccurate_count,
                actor: "mario",
                target: "platform",
              },
              read: false,
              dismissed: false,
            });
          }
        } catch (e) {
          console.warn(`[mario-stall-cron] accuracy alarm for ws=${ws.id} failed:`, e instanceof Error ? e.message : e);
        }
      }
    });

    await step.run("emit-heartbeat", async () => {
      // A dedupe hit is a real product signal (the lane is doing its job), not a cron failure.
      await emitCronHeartbeat("mario-stall-cron", { ok: true, produced: result });
    });

    return result;
  },
);
