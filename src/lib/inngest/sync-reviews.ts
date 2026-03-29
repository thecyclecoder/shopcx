/**
 * Inngest function: Sync product reviews from Klaviyo.
 * Each page of 100 reviews runs as its own durable step (safe under 300s timeout).
 * Nightly cron pulls last 30 days. On-demand pulls everything.
 */

import { inngest } from "./client";
import { buildSyncUrl, syncReviewPage, generateMissingSummaries } from "@/lib/klaviyo";
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
      return await syncWorkspace(workspaceId, fullSync, step);
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
      const result = await syncWorkspace(ws.id, false, step);
      results.push({ workspace_id: ws.id, ...result });
    }

    return { workspaces_synced: results.length, results };
  },
);

async function syncWorkspace(
  workspaceId: string,
  fullSync: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: any,
): Promise<{ synced: number; errors: number }> {
  let url: string | null = buildSyncUrl({ fullSync });
  let totalSynced = 0;
  let totalErrors = 0;
  let page = 0;

  while (url) {
    const pageUrl: string = url;
    const result: { synced: number; errors: number; nextUrl: string | null } = await step.run(
      `sync-${workspaceId}-page-${page}`,
      async () => syncReviewPage(workspaceId, pageUrl),
    );

    totalSynced += result.synced;
    totalErrors += result.errors;
    url = result.nextUrl;
    page++;
  }

  // Generate AI summaries as a separate step
  await step.run(`summaries-${workspaceId}`, async () => {
    await generateMissingSummaries(workspaceId);
  });

  // Update last sync timestamp
  await step.run(`timestamp-${workspaceId}`, async () => {
    const admin = createAdminClient();
    await admin
      .from("workspaces")
      .update({ klaviyo_last_sync_at: new Date().toISOString() })
      .eq("id", workspaceId);
  });

  return { synced: totalSynced, errors: totalErrors };
}
