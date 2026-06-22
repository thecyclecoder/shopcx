/**
 * Daily auto-review of proposed sonnet_prompts.
 *
 * Cron expression `0 11 * * *` = 11:00 UTC = 6 AM Central (during CDT).
 * Concurrency 1 — at most one workspace-sweep runs at a time across all
 * workspaces; we don't need parallelism here and serial keeps the cost
 * predictable.
 *
 * See docs/brain/specs/prompt-learning.md (the spec) and
 * docs/brain/lifecycles/ai-learning.md (the closed loop).
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { reviewWorkspace } from "@/lib/sonnet-prompt-auto-review";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const sonnetPromptAutoReviewCron = inngest.createFunction(
  {
    id: "sonnet-prompt-auto-review",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 11 * * *" },
      // Manual trigger — fire `prompt-learning/auto-review.run` to invoke
      // out of band (Inngest dashboard "Invoke", or `inngest.send` from
      // anywhere in the codebase). Used for one-off runs after the
      // human-review backlog gets cleared so we don't have to wait
      // for the next 11 UTC tick.
      { event: "prompt-learning/auto-review.run" },
    ],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaces = await step.run("find-enabled-workspaces", async () => {
      const { data } = await admin
        .from("workspaces")
        .select("id, name")
        .eq("sonnet_auto_review_enabled", true);
      return data || [];
    });

    if (!workspaces.length) {
      return { workspaces: 0, reviewed: 0, accepted: 0, humanReview: 0 };
    }

    let totalReviewed = 0,
      totalAccepted = 0,
      totalHumanReview = 0;
    const perWorkspace: any[] = [];
    const errors: string[] = [];

    for (const ws of workspaces) {
      const r = await step.run(`review-${ws.id}`, async () => {
        return reviewWorkspace(admin, ws.id);
      });
      perWorkspace.push({ workspace_id: ws.id, name: ws.name, ...r });
      totalReviewed += r.reviewed;
      totalAccepted += r.accepted;
      totalHumanReview += r.humanReview;
      if (r.errors.length) errors.push(...r.errors.map((e) => `${ws.id}: ${e}`));
    }

    const result = {
      workspaces: workspaces.length,
      reviewed: totalReviewed,
      accepted: totalAccepted,
      humanReview: totalHumanReview,
      perWorkspace,
      errors: errors.slice(0, 50),
    };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("sonnet-prompt-auto-review", { ok: true, produced: result });
    });

    return result;
  },
);
