/**
 * main-build-status-cron — the red-main pipeline alarm's monitored loop body.
 *
 * Every 15 minutes it reads the combined build status of main's HEAD commit, and on
 * failure identifies the FIRST red commit and raises a CEO-visible alarm — idempotent
 * per first_red_sha so a per-tick sweep can't fan out a new card each tick for the
 * same breakage. On success it clears any open alarm. Emits an end-of-run
 * `emitCronHeartbeat` so a dead detector is itself visible via the Control Tower.
 *
 * See [[../control-tower/main-build-status]] for the sweep body, and
 * [[../../../docs/brain/specs/a-red-main-is-a-first-class-pipeline-alarm.md]] for the
 * incident this closes.
 */
import { inngest } from "@/lib/inngest/client";
import { sweepMainBuildStatus } from "@/lib/control-tower/main-build-status";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const mainBuildStatusCron = inngest.createFunction(
  {
    id: "main-build-status",
    name: "Main build status — red-main alarm",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const startedAt = Date.now();
    let ok = true;
    let result: Awaited<ReturnType<typeof sweepMainBuildStatus>> | null = null;
    try {
      result = await step.run("sweep-main-build-status", async () => sweepMainBuildStatus());
    } catch (err) {
      ok = false;
      console.warn(
        "[main-build-status-cron] sweep threw:",
        err instanceof Error ? err.message : err,
      );
      throw err;
    } finally {
      const detail = result
        ? `state=${result.state} alarmed=${result.alarmed} resolved=${result.resolved}` +
          (result.firstRedSha ? ` first_red=${result.firstRedSha.slice(0, 7)}` : "") +
          (result.reason ? ` (${result.reason})` : "")
        : ok
          ? "no-result"
          : "threw";
      await emitCronHeartbeat("main-build-status", {
        ok,
        produced: result,
        detail,
        durationMs: Date.now() - startedAt,
      });
    }
    return result;
  },
);
