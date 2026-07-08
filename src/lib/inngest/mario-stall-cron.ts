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
import { evaluateStalledSpecs, enqueueMarioJob } from "@/lib/mario";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

/** Per-tick cap on enqueues — mirrors deploy-guardian-cron's bounded tick. */
const MARIO_PER_TICK_ENQUEUE_CAP = 25;

export const marioStallCron = inngest.createFunction(
  {
    id: "mario-stall-cron",
    // The next tick re-evaluates a minute later — no value in long retries here.
    retries: 1,
    triggers: [{ cron: "* * * * *" }], // every minute
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

    await step.run("emit-heartbeat", async () => {
      // A dedupe hit is a real product signal (the lane is doing its job), not a cron failure.
      await emitCronHeartbeat("mario-stall-cron", { ok: true, produced: result });
    });

    return result;
  },
);
