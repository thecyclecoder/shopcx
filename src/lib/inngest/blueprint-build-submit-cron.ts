/**
 * blueprint-build-submit-cron — the daily cadence backstop for the deterministic
 * verify + build-spec handoff (content-upload-and-lander-build Phase 2).
 *
 * The primary trigger is EVENT-driven — the last founder upload on a blueprint drives it
 * to `content_complete` and calls `verifyAndSubmitBlueprint` inline (see the gap-upload
 * route). This cron is the belt-and-suspenders: if that inline handoff hiccuped (a
 * spec-authoring API blip, a network fault) the blueprint sits at `content_complete` and
 * NEVER submits a spec — the sweep here picks it up on the next tick and drives it through
 * the SAME `verifyAndSubmitBlueprint` code path (submitted OR reverted to awaiting_upload).
 *
 * Idempotent under retries: `verifyAndSubmitBlueprint` no-ops on a `build_submitted` row and
 * revert-to-awaiting_upload dedupes gap re-opens by the `openContentGap` write.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { runBlueprintBuildSubmitSweep } from "@/lib/blueprint-build-submit";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const blueprintBuildSubmitCron = inngest.createFunction(
  {
    id: "blueprint-build-submit-cron",
    name: "Lander blueprint — daily verify + build-spec handoff backstop",
    retries: 1,
    concurrency: [{ limit: 1 }],
    // Daily at 11:15 UTC — offset from the other crons (spec-test-cron @ 10:45, etc.).
    triggers: [{ cron: "15 11 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("sweep-content-complete-blueprints", async () => {
      // Every workspace that has any lander_blueprint gets swept — small tables, cheap read.
      const { data: rows } = await admin.from("lander_blueprints").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((rows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) return { workspaces: 0, submitted: 0, reverted: 0, errors: 0 };
      let submitted = 0;
      let reverted = 0;
      let errors = 0;
      for (const workspaceId of workspaceIds) {
        try {
          const outcomes = await runBlueprintBuildSubmitSweep(workspaceId);
          for (const o of outcomes) {
            if (o.status === "submitted") submitted++;
            else if (o.status === "reverted") reverted++;
            else if (o.status === "error") errors++;
          }
        } catch {
          errors++;
        }
      }
      return { workspaces: workspaceIds.length, submitted, reverted, errors };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("blueprint-build-submit-cron", { ok: true, produced: result });
    });

    return result;
  },
);
