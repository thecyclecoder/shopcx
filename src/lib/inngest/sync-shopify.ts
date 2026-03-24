import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getShopifyCounts,
  cancelBulkOperation,
  startBulkOperation,
  pollBulkOperation,
  downloadBulkCustomerUrl,
  upsertCustomerChunk,
  downloadBulkOrderUrl,
  upsertOrderChunk,
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
      await admin.from("sync_jobs").update(updates).eq("id", job_id);
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

    // ── CUSTOMERS ──

    // Cancel stale bulk op
    await step.run("cancel-stale-bulk-op", async () => {
      await cancelBulkOperation(workspace_id);
    });

    // Start bulk customer query
    await step.run("start-bulk-customers", async () => {
      await startBulkOperation(workspace_id, BULK_CUSTOMERS_QUERY);
    });

    // Poll until complete
    let customerBulkDone = false;
    let pollCount = 0;

    while (!customerBulkDone && pollCount < 200) {
      const pollNum = pollCount;
      const pollResult: { status: string; objectCount: number; url: string | null } =
        await step.run(`poll-bulk-customers-${pollNum}`, async () => {
          await new Promise((r) => setTimeout(r, 10000));
          const result = await pollBulkOperation(workspace_id);
          await updateJob({ synced_customers: result.objectCount });
          return result;
        });

      pollCount++;

      if (pollResult.status === "completed") {
        customerBulkDone = true;
      } else if (pollResult.status === "failed") {
        throw new Error("Bulk customer sync failed on Shopify side");
      }
    }

    if (!customerBulkDone) {
      throw new Error("Bulk customer sync timed out");
    }

    // Download URL
    const customerUrl: string = await step.run("get-customer-download-url", async () => {
      return downloadBulkCustomerUrl(workspace_id);
    });

    // Upsert in chunks (50K per step)
    let customersSynced = 0;
    let customerChunk = 0;
    let hasMoreCustomers = true;

    while (hasMoreCustomers) {
      const chunkNum = customerChunk;
      const chunkResult: { synced: number; hasMore: boolean } =
        await step.run(`upsert-customers-chunk-${chunkNum}`, async () => {
          return upsertCustomerChunk(workspace_id, customerUrl, chunkNum);
        });

      customersSynced += chunkResult.synced;
      hasMoreCustomers = chunkResult.hasMore;
      customerChunk++;

      await step.run(`update-customer-progress-${customerChunk}`, async () => {
        await updateJob({ synced_customers: customersSynced });
      });
    }

    // ── ORDERS ──

    await step.run("switch-to-orders", async () => {
      await updateJob({ phase: "orders" });
    });

    // Cancel stale bulk op from customer phase
    await step.run("cancel-stale-bulk-op-orders", async () => {
      await cancelBulkOperation(workspace_id);
    });

    await step.run("start-bulk-orders", async () => {
      await startBulkOperation(workspace_id, BULK_ORDERS_QUERY);
    });

    let orderBulkDone = false;
    let orderPollCount = 0;

    while (!orderBulkDone && orderPollCount < 200) {
      const pollNum = orderPollCount;
      const pollResult: { status: string; objectCount: number; url: string | null } =
        await step.run(`poll-bulk-orders-${pollNum}`, async () => {
          await new Promise((r) => setTimeout(r, 10000));
          const result = await pollBulkOperation(workspace_id);
          await updateJob({ synced_orders: result.objectCount });
          return result;
        });

      orderPollCount++;

      if (pollResult.status === "completed") {
        orderBulkDone = true;
      } else if (pollResult.status === "failed") {
        throw new Error("Bulk order sync failed on Shopify side");
      }
    }

    if (!orderBulkDone) {
      throw new Error("Bulk order sync timed out");
    }

    const orderUrl: string = await step.run("get-order-download-url", async () => {
      return downloadBulkOrderUrl(workspace_id);
    });

    let ordersSynced = 0;
    let orderChunk = 0;
    let hasMoreOrders = true;

    while (hasMoreOrders) {
      const chunkNum = orderChunk;
      const chunkResult: { synced: number; hasMore: boolean } =
        await step.run(`upsert-orders-chunk-${chunkNum}`, async () => {
          return upsertOrderChunk(workspace_id, orderUrl, chunkNum);
        });

      ordersSynced += chunkResult.synced;
      hasMoreOrders = chunkResult.hasMore;
      orderChunk++;

      await step.run(`update-order-progress-${orderChunk}`, async () => {
        await updateJob({ synced_orders: ordersSynced });
      });
    }

    // ── FINALIZE ──

    await step.run("finalize", async () => {
      await updateJob({ phase: "finalizing" });
      await finalizeSyncOrderDates(workspace_id);
      await updateRetentionScores(workspace_id);
    });

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
