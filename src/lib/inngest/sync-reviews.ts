/**
 * Inngest function: Sync product reviews from Klaviyo.
 * Runs nightly or on-demand from settings.
 */

import { inngest } from "./client";
import { syncReviewsForWorkspace } from "@/lib/klaviyo";
import { createAdminClient } from "@/lib/supabase/admin";

export const syncKlaviyoReviews = inngest.createFunction(
  {
    id: "sync-klaviyo-reviews",
    retries: 2,
    triggers: [
      { event: "klaviyo/sync-reviews" },
      { cron: "0 3 * * *" }, // 3am daily
    ],
  },
  async ({ event, step }) => {
    // If triggered by event, sync specific workspace
    // If cron, sync all workspaces with Klaviyo configured
    const workspaceId = (event?.data as { workspace_id?: string })?.workspace_id;

    if (workspaceId) {
      const result = await step.run("sync-workspace", async () => {
        return syncReviewsForWorkspace(workspaceId);
      });
      return { workspace_id: workspaceId, ...result };
    }

    // Cron: sync all workspaces with Klaviyo configured
    const workspaces = await step.run("fetch-workspaces", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("workspaces")
        .select("id")
        .not("klaviyo_api_key_encrypted", "is", null);
      return data || [];
    });

    const results: { workspace_id: string; synced: number; errors: number }[] = [];

    for (const ws of workspaces) {
      const result = await step.run(`sync-${ws.id}`, async () => {
        return syncReviewsForWorkspace(ws.id);
      });
      results.push({ workspace_id: ws.id, ...result });
    }

    return { workspaces_synced: results.length, results };
  },
);
