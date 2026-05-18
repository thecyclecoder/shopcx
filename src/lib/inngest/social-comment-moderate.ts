/**
 * Async moderation handler. Triggered by ingest with:
 *   { workspace_id, social_comment_id, platform }
 *
 * Step 1: call Sonnet → ModerationDecision
 * Step 2: apply the decision (sandbox: stamp suggestion only; live: fire
 *         Graph API + reconcile)
 *
 * Concurrency is keyed on workspace so a single page taking a wave of
 * comments doesn't starve other workspaces' AI calls.
 */
import { inngest } from "@/lib/inngest/client";
import { moderateSocialComment } from "@/lib/social-comment-orchestrator";
import { applyModerationDecision } from "@/lib/social-comment-actions";

export const socialCommentModerate = inngest.createFunction(
  {
    id: "social-comment-moderate",
    retries: 2,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "social/comment.created" }],
  },
  async ({ event, step }) => {
    const { workspace_id, social_comment_id } = event.data as {
      workspace_id: string;
      social_comment_id: string;
    };

    const decision = await step.run("sonnet-moderate", async () =>
      moderateSocialComment(workspace_id, social_comment_id),
    );

    const result = await step.run("apply-decision", async () =>
      applyModerationDecision(workspace_id, social_comment_id, decision),
    );

    return { decision, result };
  },
);
