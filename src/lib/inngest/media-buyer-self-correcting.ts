/**
 * media-buyer-self-correcting — daily cron that walks armed Media Buyer cohorts
 * and auto-flips them back to `shadow` on a sustained grade regression
 * ([[../../../docs/brain/specs/media-buyer-self-correcting-mode-revert]] Phase 1,
 * closing the [[../../../docs/brain/goals/autonomous-media-buyer-supervision]]
 * M4 "graded + self-correcting" loop).
 *
 * The scoring cron `media-buyer-grade-cron` runs at `0 14 * * *` UTC and writes
 * new rows to [[../../../docs/brain/tables/media_buyer_action_grades]]. This
 * cron fires 30 minutes later (`30 14 * * *`) so it reads a settled batch: fan
 * out one `growth/media-buyer-self-correcting-sweep` event per armed
 * workspace, then each sweep iterates the workspace's Media-Buyer cohorts
 * (distinct `meta_ad_account_id` values from the joined `director_activity`,
 * plus the workspace-wide cohort) and calls
 * [[../media-buyer/self-correcting]] `checkMediaBuyerRegressionAndDisarm`.
 * Idempotent: a re-run against an already-shadow policy no-ops; the CEO
 * escalation dedupes on `media_buyer_regressed_disarmed:{ws}:{acct|_workspace_}`
 * (dashboard_notifications-scoped, see [[../agents/platform-director]]).
 *
 * Self-monitoring: emits a `media-buyer-self-correcting-cron` heartbeat at end
 * via [[../control-tower/heartbeat]] `emitCronHeartbeat` — a dead sweep shows
 * on the Control Tower.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import {
  checkMediaBuyerRegressionAndDisarm,
  findArmedWorkspaces,
  findCohortMetaAdAccountIds,
} from "@/lib/media-buyer/self-correcting";

export const mediaBuyerSelfCorrectingCron = inngest.createFunction(
  {
    id: "media-buyer-self-correcting-cron",
    name: "Growth — media buyer self-correcting mode revert",
    retries: 1,
    concurrency: [{ limit: 1 }],
    // 30 minutes after mediaBuyerGradeCron so the sweep reads settled per-day grades.
    triggers: [{ cron: "30 14 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaceIds = await step.run("find-armed-workspaces", async () => {
      return findArmedWorkspaces(admin);
    });

    for (const workspaceId of workspaceIds) {
      await step.run(`fan-out-${workspaceId}`, async () => {
        await inngest.send({
          name: "growth/media-buyer-self-correcting-sweep",
          data: { workspace_id: workspaceId, trigger: "cron" },
        });
      });
    }

    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("media-buyer-self-correcting-cron", {
        ok: true,
        produced: result,
        detail: `fanned out ${result.workspaces} armed workspace(s)`,
      });
    });
    return result;
  },
);

export const mediaBuyerSelfCorrectingSweep = inngest.createFunction(
  {
    id: "media-buyer-self-correcting-sweep",
    name: "Growth — media buyer self-correcting per-workspace pass",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "growth/media-buyer-self-correcting-sweep" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as {
      workspace_id: string;
      trigger?: "cron" | "manual";
    };
    const admin = createAdminClient();

    const cohorts = await step.run("find-cohorts", async () => {
      return findCohortMetaAdAccountIds(admin, { workspaceId: workspace_id });
    });

    const summary = { checked: 0, disarmed: 0, errors: 0 };
    for (const metaAdAccountId of cohorts) {
      const label = metaAdAccountId ?? "_workspace_";
      const outcome = await step.run(`check-${label}`, async () => {
        return checkMediaBuyerRegressionAndDisarm({
          admin,
          workspaceId: workspace_id,
          metaAdAccountId,
        });
      });
      summary.checked += 1;
      if (outcome.disarmed) summary.disarmed += 1;
      else if (outcome.reason === "error") summary.errors += 1;
      // Once disarmed the workspace's active v1 policy is workspace-wide 'shadow' — the
      // remaining per-account passes will yield `not_armed` and are idempotent no-ops.
    }
    console.log(
      `[media-buyer-self-correcting] ws=${workspace_id} checked=${summary.checked} disarmed=${summary.disarmed} errors=${summary.errors}`,
    );
    return { status: "complete", workspace_id, ...summary };
  },
);
