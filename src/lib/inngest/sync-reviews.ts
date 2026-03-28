/**
 * Inngest function: Sync product reviews from Klaviyo.
 * Nightly cron pulls last 30 days (lightweight). On-demand pulls everything.
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
    const eventData = event?.data as { workspace_id?: string; full_sync?: boolean } | undefined;
    const workspaceId = eventData?.workspace_id;
    const fullSync = eventData?.full_sync ?? false;

    if (workspaceId) {
      // Triggered for a specific workspace (manual or event)
      const result = await step.run("sync-workspace", async () => {
        return syncReviewsForWorkspace(workspaceId, { fullSync });
      });
      return { workspace_id: workspaceId, ...result };
    }

    // Cron: sync all workspaces with Klaviyo configured (30-day window)
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
        return syncReviewsForWorkspace(ws.id, { fullSync: false });
      });
      results.push({ workspace_id: ws.id, ...result });
    }

    return { workspaces_synced: results.length, results };
  },
);
