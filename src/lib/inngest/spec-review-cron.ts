/**
 * spec-review-cron — the periodic enqueuer for the box-hosted **spec-review agent** (Vale)
 * ([[../specs/spec-review-agent]]).
 *
 * Whenever ≥1 spec is parked in `in_review` (the column ahead of `planned` — the build-pipeline
 * hard-stop), this cron inserts one `agent_jobs` row `kind='spec-review'` per build-console workspace so
 * the box's spec-review lane (`runSpecReviewJob`) picks it up and reviews every in-review spec on Max.
 *
 * Same enqueue-only shape as [[spec-test-cron]] / [[triage-escalations]] — the box has no internal
 * ticker, so an Inngest cron is the trigger. **This cron does NO reasoning** — purely the enqueue.
 * Deduped via `enqueueSpecReviewIfDue` (no pile-up if a pass is already in flight).
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueSpecReviewIfDue } from "@/lib/agents/spec-review";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const specReviewCron = inngest.createFunction(
  {
    id: "spec-review-cron",
    name: "Spec-review — periodic Vale enqueue over in_review specs",
    retries: 1,
    concurrency: [{ limit: 1 }],
    // Every 15 min — Vale clears the in_review backlog briskly so a newly authored spec doesn't sit long
    // (the build pipeline is gated behind it). Offset to keep clear of the other crons.
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-spec-review-jobs", async () => {
      // Build-console workspaces: any workspace with an agent_jobs row (mirrors spec-test-cron).
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) return { workspaces: 0, enqueued: 0, pending: 0 };

      let enqueued = 0;
      let pending = 0;
      for (const workspaceId of workspaceIds) {
        const r = await enqueueSpecReviewIfDue(workspaceId);
        if (r.enqueued) enqueued++;
        if (r.pending) pending += r.pending;
      }
      return { workspaces: workspaceIds.length, enqueued, pending };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("spec-review-cron", { ok: true, produced: result });
    });

    return result;
  },
);
