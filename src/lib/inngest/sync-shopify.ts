import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getShopifyCounts,
  syncCustomerPages,
  syncOrderPages,
  bulkSyncCustomers,
  finalizeSyncOrderDates,
} from "@/lib/shopify-sync";
import { updateRetentionScores } from "@/lib/retention-score";

export const syncShopify = inngest.createFunction(
  {
    id: "sync-shopify",
    retries: 3,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "shopify/sync.requested" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id } = event.data as {
      workspace_id: string;
      job_id: string;
    };

    const admin = createAdminClient();

    // Helper to update job progress
    async function updateJob(updates: Record<string, unknown>) {
      await admin
        .from("sync_jobs")
        .update(updates)
        .eq("id", job_id);
    }

    // Step 1: Get counts
    const counts = await step.run("get-counts", async () => {
      await updateJob({ status: "running", phase: "customers" });
      return getShopifyCounts(workspace_id);
    });

    await step.run("update-counts", async () => {
      await updateJob({
        total_customers: counts.customers,
        total_orders: counts.orders,
      });
    });

    // Step 2: Sync customers — choose strategy based on DB state
    const customerSyncMode: "skip" | "bulk" | "paginated" = await step.run("check-customer-sync", async () => {
      const { count } = await admin
        .from("customers")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace_id);

      const dbCount = count || 0;
      const threshold = counts.customers * 0.01;

      // Already synced (within 1%)
      if (dbCount > 0 && Math.abs(dbCount - counts.customers) <= threshold) return "skip";
      // Large initial sync — use bulk operations (single Shopify job, no step limit issues)
      if (counts.customers > 5000 && dbCount < counts.customers * 0.5) return "bulk";
      // Small or incremental — use paginated
      return "paginated";
    });

    let customersSynced = 0;

    if (customerSyncMode === "skip") {
      await step.run("skip-customers", async () => {
        await updateJob({ synced_customers: counts.customers });
      });
      customersSynced = counts.customers;
    } else if (customerSyncMode === "bulk") {
      // Bulk operation: one step, Shopify handles pagination internally
      customersSynced = await step.run("bulk-sync-customers", async () => {
        await updateJob({ phase: "customers" });
        return bulkSyncCustomers(workspace_id, async (synced) => {
          await updateJob({ synced_customers: synced });
        });
      });
      await step.run("update-bulk-customer-count", async () => {
        await updateJob({ synced_customers: customersSynced });
      });
    } else {
      // Paginated sync
      let customerCursor: string | null = null;
      let customerBatch = 0;

      while (true) {
        const cursor: string | null = customerCursor;
        const batchNum = customerBatch;
        const result: { synced: number; nextCursor: string | null; hasMore: boolean } =
          await step.run(`sync-customers-batch-${batchNum}`, () =>
            syncCustomerPages(workspace_id, cursor)
          );

        customersSynced += result.synced;
        customerCursor = result.nextCursor;
        customerBatch++;

        if (customerBatch % 5 === 0 || !result.hasMore) {
          await step.run(`update-customer-progress-${customerBatch}`, async () => {
            await updateJob({ synced_customers: customersSynced });
          });
        }

        if (!result.hasMore) break;
      }
    }

    // Step 3: Sync orders
    await step.run("switch-to-orders", async () => {
      await updateJob({ phase: "orders" });
    });

    let orderCursor: string | null = null;
    let ordersSynced = 0;
    let orderBatch = 0;

    while (true) {
      const cursor: string | null = orderCursor;
      const batchNum = orderBatch;
      const result: { synced: number; nextCursor: string | null; hasMore: boolean } =
        await step.run(`sync-orders-batch-${batchNum}`, () =>
          syncOrderPages(workspace_id, cursor)
        );

      ordersSynced += result.synced;
      orderCursor = result.nextCursor;
      orderBatch++;

      // Update progress every 5 batches to save steps
      if (orderBatch % 5 === 0 || !result.hasMore) {
        await step.run(`update-order-progress-${orderBatch}`, async () => {
          await updateJob({ synced_orders: ordersSynced });
        });
      }

      if (!result.hasMore) break;
    }

    // Step 4: Finalize
    await step.run("finalize", async () => {
      await updateJob({ phase: "finalizing" });
      await finalizeSyncOrderDates(workspace_id);
      await updateRetentionScores(workspace_id);
    });

    // Step 5: Mark complete
    await step.run("complete", async () => {
      await updateJob({
        status: "completed",
        synced_customers: customersSynced,
        synced_orders: ordersSynced,
        completed_at: new Date().toISOString(),
      });
    });

    return {
      customers_synced: customersSynced,
      orders_synced: ordersSynced,
    };
  }
);
