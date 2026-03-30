import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

const BATCH_SIZE = 500;

export const ticketAutoArchive = inngest.createFunction(
  {
    id: "tickets-auto-archive",
    retries: 1,
    triggers: [{ cron: "0 9 * * *" }], // Daily at 9 AM UTC (3 AM Central)
  },
  async ({ step }) => {
    let totalArchived = 0;

    // Process in batches to avoid long-running queries
    let hasMore = true;
    let batch = 0;

    while (hasMore) {
      const batchNum = batch;
      const archived = await step.run(`archive-batch-${batchNum}`, async () => {
        const admin = createAdminClient();
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Select candidates
        const { data: candidates } = await admin
          .from("tickets")
          .select("id")
          .eq("status", "closed")
          .not("closed_at", "is", null)
          .lt("closed_at", cutoff)
          .limit(BATCH_SIZE);

        if (!candidates?.length) return 0;

        const now = new Date().toISOString();
        const ids = candidates.map((t) => t.id);

        const { error } = await admin
          .from("tickets")
          .update({ status: "archived", archived_at: now, updated_at: now })
          .in("id", ids);

        if (error) {
          console.error("Auto-archive batch error:", error.message);
          return 0;
        }

        return ids.length;
      });

      totalArchived += archived;
      hasMore = archived === BATCH_SIZE;
      batch++;
    }

    console.log(`Auto-archive: archived ${totalArchived} tickets`);
    return { archived: totalArchived };
  }
);
