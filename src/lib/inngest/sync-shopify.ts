import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getShopifyCounts,
  syncCustomerBatch,
  syncOrderBatch,
  finalizeSyncOrderDates,
} from "@/lib/shopify-sync";
import { updateRetentionScores } from "@/lib/retention-score";

// ── Sync Customers: paginate newest-first, 2500 per step ──
export const syncCustomers = inngest.createFunction(
  {
    id: "sync-shopify-customers",
    retries: 3,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "shopify/sync.customers" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id } = event.data as { workspace_id: string; job_id: string };
    const admin = createAdminClient();

    async function updateJob(updates: Record<string, unknown>) {
      await admin.from("sync_jobs").update(updates).eq("id", job_id);
    }

    // Resume support
    const resumeInfo: { cursor: string | null; previousSynced: number } = await step.run("check-resume", async () => {
      const { data: job } = await admin.from("sync_jobs").select("last_completed_month, synced_customers").eq("id", job_id).single();
      // Reuse last_completed_month to store cursor index for resume
      return { cursor: null, previousSynced: job?.synced_customers || 0 };
    });

    const counts = await step.run("get-counts", async () => {
      await updateJob({ status: "running", phase: "customers" });
      return getShopifyCounts(workspace_id);
    });

    await step.run("update-counts", async () => {
      await updateJob({ total_customers: counts.customers });
    });

    let customersSynced = resumeInfo.previousSynced;
    let cursor: string | null = resumeInfo.cursor;
    let batchNum = 0;
    let done = false;

    while (!done) {
      const bn = batchNum;
      const cursorForStep: string | null = cursor;

      const result: { synced: number; nextCursor: string | null; hasMore: boolean } =
        await step.run(`batch-${bn}`, () =>
          syncCustomerBatch(workspace_id, cursorForStep)
        );

      customersSynced += result.synced;
      cursor = result.nextCursor;
      done = !result.hasMore;
      batchNum++;

      // Update progress every 5 batches (12,500 customers)
      if (batchNum % 5 === 0 || done) {
        await step.run(`progress-${batchNum}`, () =>
          updateJob({ synced_customers: customersSynced, current_month: batchNum })
        );
      }
    }

    await step.run("finalize", async () => {
      await updateJob({ phase: "finalizing" });
      await updateRetentionScores(workspace_id);
    });

    await step.run("complete", async () => {
      await updateJob({ status: "completed", synced_customers: customersSynced, completed_at: new Date().toISOString() });
    });

    return { customers_synced: customersSynced };
  }
);

// ── Sync Orders: paginate newest-first, 2500 per step ──
export const syncOrders = inngest.createFunction(
  {
    id: "sync-shopify-orders",
    retries: 3,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "shopify/sync.orders" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id } = event.data as { workspace_id: string; job_id: string };
    const admin = createAdminClient();

    async function updateJob(updates: Record<string, unknown>) {
      await admin.from("sync_jobs").update(updates).eq("id", job_id);
    }

    const counts = await step.run("get-counts", async () => {
      await updateJob({ status: "running", phase: "orders" });
      return getShopifyCounts(workspace_id);
    });

    await step.run("update-counts", async () => {
      await updateJob({ total_orders: counts.orders });
    });

    let ordersSynced = 0;
    let cursor: string | null = null;
    let batchNum = 0;
    let done = false;

    while (!done) {
      const bn = batchNum;
      const cursorForStep: string | null = cursor;

      const result: { synced: number; nextCursor: string | null; hasMore: boolean } =
        await step.run(`batch-${bn}`, () =>
          syncOrderBatch(workspace_id, cursorForStep)
        );

      ordersSynced += result.synced;
      cursor = result.nextCursor;
      done = !result.hasMore;
      batchNum++;

      if (batchNum % 5 === 0 || done) {
        await step.run(`progress-${batchNum}`, () =>
          updateJob({ synced_orders: ordersSynced, current_month: batchNum })
        );
      }
    }

    await step.run("finalize", async () => {
      await updateJob({ phase: "finalizing" });
      await finalizeSyncOrderDates(workspace_id);
      await updateRetentionScores(workspace_id);
    });

    await step.run("complete", async () => {
      await updateJob({ status: "completed", synced_orders: ordersSynced, completed_at: new Date().toISOString() });
    });

    return { orders_synced: ordersSynced };
  }
);
