/**
 * deploy-guardian-cron — Reva's evaluation tick (docs/brain/specs/deploy-health-rollback-guardian.md,
 * Phase 1).
 *
 * Every minute: evaluate every `deploy_watches` row whose canary window has elapsed. Each watch was
 * opened by [[../deploy-guardian]] `openDeployWatch` when the auto-merge gate squash-merged a
 * claude/<slug> build branch. The evaluation samples NEW error_events + NEW open loop_alerts + the live
 * Control-Tower snapshot — attributing only signals that FIRST appear AFTER the deploy timestamp — and
 * stamps a verdict: healthy | regressed | unsure (+ a director_activity row). Phase 1 watches + stamps;
 * Phase 2 acts (auto-rollback) on `regressed`.
 *
 * Runs in the Vercel/Inngest runtime (where the error feed lives), NOT the box — no token burn, reuses
 * Tao's signals. See [[../deploy-guardian]] · [[../../tables/deploy_watches]].
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluateDueDeployWatches } from "@/lib/deploy-guardian";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const deployGuardianCron = inngest.createFunction(
  {
    id: "deploy-guardian-cron",
    retries: 1, // the next tick re-evaluates a minute later — no value in long retries here
    triggers: [{ cron: "* * * * *" }], // every minute
  },
  async ({ step }) => {
    const result = await step.run("evaluate-due-deploy-watches", async () => {
      const admin = createAdminClient();
      return evaluateDueDeployWatches(admin);
    });
    await step.run("emit-heartbeat", async () => {
      // ok = the tick completed; a `regressed`/`unsure` verdict is a real product signal, not a cron failure.
      await emitCronHeartbeat("deploy-guardian-cron", { ok: true, produced: result });
    });
    return result;
  },
);
