import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getShopifyCounts,
  syncCustomerBatch,
  syncOrderBatch,
  preloadCustomerMaps,
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

    // Resume support — pick up from last cursor
    const resumeInfo: { cursor: string | null; previousSynced: number; startBatch: number } = await step.run("check-resume", async () => {
      const { data: job } = await admin.from("sync_jobs").select("last_cursor, synced_customers, current_month").eq("id", job_id).single();
      return {
        cursor: job?.last_cursor || null,
        previousSynced: job?.synced_customers || 0,
        startBatch: job?.current_month || 0,
      };
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
    let batchNum = resumeInfo.startBatch;
    let done = false;

    while (!done) {
      const bn = batchNum;
      const cursorForStep: string | null = cursor;

      const result: { synced: number; nextCursor: string | null; hasMore: boolean } =
        await step.run(`batch-${bn}`, async () => {
          const r = await syncCustomerBatch(workspace_id, cursorForStep);
          // Update progress in same step to halve step count
          await updateJob({ synced_customers: customersSynced + r.synced, last_cursor: r.nextCursor, current_month: bn + 1 });
          return r;
        });

      customersSynced += result.synced;
      cursor = result.nextCursor;
      done = !result.hasMore;
      batchNum++;
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

    const resumeInfo: { cursor: string | null; previousSynced: number; startBatch: number } = await step.run("check-resume", async () => {
      const { data: job } = await admin.from("sync_jobs").select("last_cursor, synced_orders, current_month").eq("id", job_id).single();
      return {
        cursor: job?.last_cursor || null,
        previousSynced: job?.synced_orders || 0,
        startBatch: job?.current_month || 0,
      };
    });

    const counts = await step.run("get-counts", async () => {
      await updateJob({ status: "running", phase: "orders" });
      return getShopifyCounts(workspace_id);
    });

    await step.run("update-counts", async () => {
      await updateJob({ total_orders: counts.orders });
    });

    // Preload customer maps once — memoized so it runs exactly once even on restart
    const customerMaps = await step.run("preload-customers", async () => {
      return preloadCustomerMaps(workspace_id);
    });

    let ordersSynced = resumeInfo.previousSynced;
    let cursor: string | null = resumeInfo.cursor;
    let batchNum = resumeInfo.startBatch;
    let done = false;

    while (!done) {
      const bn = batchNum;
      const cursorForStep: string | null = cursor;

      const result: { synced: number; nextCursor: string | null; hasMore: boolean } =
        await step.run(`batch-${bn}`, async () => {
          const r = await syncOrderBatch(workspace_id, cursorForStep, customerMaps);
          await updateJob({ synced_orders: ordersSynced + r.synced, last_cursor: r.nextCursor, current_month: bn + 1 });
          return r;
        });

      ordersSynced += result.synced;
      cursor = result.nextCursor;
      done = !result.hasMore;
      batchNum++;
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
