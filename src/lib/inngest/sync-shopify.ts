import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getShopifyCounts,
  cancelBulkOperation,
  startBulkOperationWithQuery,
  pollBulkOperation,
  downloadAndUpsertCustomers,
  downloadAndUpsertOrders,
  finalizeSyncOrderDates,
} from "@/lib/shopify-sync";
import { updateRetentionScores } from "@/lib/retention-score";

// Generate month ranges from current month going backwards
function getMonthRanges(maxMonths: number = 36): { start: string; end: string; label: string }[] {
  const ranges: { start: string; end: string; label: string }[] = [];
  const now = new Date();

  for (let i = 0; i < maxMonths; i++) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    ranges.push({
      start: start.toISOString(),
      end: end.toISOString(),
      label: start.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
    });
  }

  return ranges;
}

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

    const months = getMonthRanges(36);

    // ── CUSTOMERS: sync month by month (current → oldest, max 36 months) ──
    let customersSynced = 0;
    let emptyCustomerMonths = 0;

    for (let m = 0; m < months.length; m++) {
      if (emptyCustomerMonths >= 3) break;

      const month = months[m];
      const monthIdx = m;

      await step.run(`cancel-cust-${monthIdx}`, () => cancelBulkOperation(workspace_id));

      await step.run(`start-cust-${monthIdx}`, () =>
        startBulkOperationWithQuery(workspace_id, "customers", month.start, month.end)
      );

      let done = false;
      let pollCount = 0;
      while (!done && pollCount < 60) {
        const pollNum = pollCount;
        const pollResult: { status: string; objectCount: number; url: string | null } =
          await step.run(`poll-cust-${monthIdx}-${pollNum}`, async () => {
            await new Promise((r) => setTimeout(r, 20000));
            return pollBulkOperation(workspace_id);
          });
        pollCount++;
        if (pollResult.status === "completed" || pollResult.status === "failed") done = true;
      }

      const synced: number = await step.run(`upsert-cust-${monthIdx}`, () =>
        downloadAndUpsertCustomers(workspace_id)
      );

      customersSynced += synced;
      emptyCustomerMonths = synced === 0 ? emptyCustomerMonths + 1 : 0;

      await step.run(`progress-cust-${monthIdx}`, () =>
        updateJob({ synced_customers: customersSynced, current_month: m + 1 })
      );
    }

    // ── ORDERS: sync month by month ──
    await step.run("switch-to-orders", () => updateJob({ phase: "orders" }));

    let ordersSynced = 0;
    let emptyOrderMonths = 0;

    for (let m = 0; m < months.length; m++) {
      if (emptyOrderMonths >= 3) break;

      const month = months[m];
      const monthIdx = m;

      await step.run(`cancel-ord-${monthIdx}`, () => cancelBulkOperation(workspace_id));

      await step.run(`start-ord-${monthIdx}`, () =>
        startBulkOperationWithQuery(workspace_id, "orders", month.start, month.end)
      );

      let done = false;
      let pollCount = 0;
      while (!done && pollCount < 60) {
        const pollNum = pollCount;
        const pollResult: { status: string; objectCount: number; url: string | null } =
          await step.run(`poll-ord-${monthIdx}-${pollNum}`, async () => {
            await new Promise((r) => setTimeout(r, 20000));
            return pollBulkOperation(workspace_id);
          });
        pollCount++;
        if (pollResult.status === "completed" || pollResult.status === "failed") done = true;
      }

      const synced: number = await step.run(`upsert-ord-${monthIdx}`, () =>
        downloadAndUpsertOrders(workspace_id)
      );

      ordersSynced += synced;
      emptyOrderMonths = synced === 0 ? emptyOrderMonths + 1 : 0;

      await step.run(`progress-ord-${monthIdx}`, () =>
        updateJob({ synced_orders: ordersSynced, current_month: m + 1 })
      );
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

    return { customers_synced: customersSynced, orders_synced: ordersSynced };
  }
);
