import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getShopifyCounts,
  cancelBulkOperation,
  startBulkOperation,
  pollBulkOperation,
  bulkSyncCustomers,
  bulkSyncOrders,
  finalizeSyncOrderDates,
  BULK_CUSTOMERS_QUERY,
  BULK_ORDERS_QUERY,
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

    // Step 2: Check if customers need syncing
    const shouldSyncCustomers: boolean = await step.run("check-customer-sync", async () => {
      const { count } = await admin
        .from("customers")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace_id);
      const dbCount = count || 0;
      const threshold = counts.customers * 0.01;
      return !dbCount || Math.abs(dbCount - counts.customers) > threshold;
    });

    let customersSynced = 0;

    if (!shouldSyncCustomers) {
      await step.run("skip-customers", async () => {
        await updateJob({ synced_customers: counts.customers });
      });
      customersSynced = counts.customers;
    } else {
      // Step 3a: Cancel any stale bulk operation
      await step.run("cancel-stale-bulk-op", async () => {
        await cancelBulkOperation(workspace_id);
      });

      // Step 3b: Start bulk operation
      await step.run("start-bulk-customers", async () => {
        await startBulkOperation(workspace_id, BULK_CUSTOMERS_QUERY);
      });

      // Step 3c: Poll until complete (each poll is a step — handles Vercel timeout)
      let bulkDone = false;
      let pollCount = 0;

      while (!bulkDone && pollCount < 120) {
        const pollNum = pollCount;
        const pollResult: { status: string; objectCount: number; url: string | null } =
          await step.run(`poll-bulk-customers-${pollNum}`, async () => {
            await new Promise((r) => setTimeout(r, 10000));
            const result = await pollBulkOperation(workspace_id);
            await updateJob({
              synced_customers: result.objectCount,
              total_customers: result.objectCount,
            });
            return result;
          });

        pollCount++;

        if (pollResult.status === "completed") {
          bulkDone = true;

          // Step 3d: Download and upsert
          customersSynced = await step.run("download-and-upsert-customers", async () => {
            return bulkSyncCustomers(workspace_id, async (synced) => {
              await updateJob({ synced_customers: synced });
            });
          });

          await step.run("update-customer-final", async () => {
            await updateJob({ synced_customers: customersSynced });
          });
        } else if (pollResult.status === "failed") {
          throw new Error("Bulk customer sync failed on Shopify side");
        }
        // status === "running" → loop and poll again
      }

      if (!bulkDone) {
        throw new Error("Bulk customer sync timed out after 20 minutes of polling");
      }
    }

    // Step 4: Sync orders via bulk operation
    await step.run("switch-to-orders", async () => {
      await updateJob({ phase: "orders" });
    });

    let ordersSynced = 0;

    // Cancel any stale bulk op from customer phase
    await step.run("cancel-stale-bulk-op-orders", async () => {
      await cancelBulkOperation(workspace_id);
    });

    // Start bulk order query
    await step.run("start-bulk-orders", async () => {
      await startBulkOperation(workspace_id, BULK_ORDERS_QUERY);
    });

    // Poll until complete
    let orderBulkDone = false;
    let orderPollCount = 0;

    while (!orderBulkDone && orderPollCount < 120) {
      const pollNum = orderPollCount;
      const pollResult: { status: string; objectCount: number; url: string | null } =
        await step.run(`poll-bulk-orders-${pollNum}`, async () => {
          await new Promise((r) => setTimeout(r, 10000));
          const result = await pollBulkOperation(workspace_id);
          // Use objectCount as both progress and running total
          await updateJob({
            synced_orders: result.objectCount,
            total_orders: result.objectCount,
          });
          return result;
        });

      orderPollCount++;

      if (pollResult.status === "completed") {
        orderBulkDone = true;

        ordersSynced = await step.run("download-and-upsert-orders", async () => {
          return bulkSyncOrders(workspace_id, async (synced) => {
            await updateJob({ synced_orders: synced });
          });
        });

        await step.run("update-order-final", async () => {
          await updateJob({ synced_orders: ordersSynced });
        });
      } else if (pollResult.status === "failed") {
        throw new Error("Bulk order sync failed on Shopify side");
      }
    }

    if (!orderBulkDone) {
      throw new Error("Bulk order sync timed out after 20 minutes of polling");
    }

    // Step 5: Finalize
    await step.run("finalize", async () => {
      await updateJob({ phase: "finalizing" });
      await finalizeSyncOrderDates(workspace_id);
      await updateRetentionScores(workspace_id);
    });

    // Step 6: Mark complete
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
