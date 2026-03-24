import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getShopifyCounts,
  syncCustomerMonth,
  syncOrderMonth,
  finalizeSyncOrderDates,
} from "@/lib/shopify-sync";
import { updateRetentionScores } from "@/lib/retention-score";

function getMonthRanges(maxMonths: number = 36): { start: string; end: string }[] {
  const ranges: { start: string; end: string }[] = [];
  const now = new Date();
  for (let i = 0; i < maxMonths; i++) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    ranges.push({ start: start.toISOString(), end: end.toISOString() });
  }
  return ranges;
}

// ── Sync Customers (paginated, month by month) ──
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

    const resumeInfo: { startMonth: number; previousSynced: number } = await step.run("check-resume", async () => {
      const { data: job } = await admin.from("sync_jobs").select("last_completed_month, synced_customers").eq("id", job_id).single();
      return { startMonth: job?.last_completed_month || 0, previousSynced: job?.synced_customers || 0 };
    });

    const counts = await step.run("get-counts", async () => {
      await updateJob({ status: "running", phase: "customers", total_months: 36 });
      return getShopifyCounts(workspace_id);
    });

    await step.run("update-counts", async () => {
      await updateJob({ total_customers: counts.customers });
    });

    const months = getMonthRanges(36);
    let customersSynced = resumeInfo.previousSynced;
    let emptyMonths = 0;

    for (let m = resumeInfo.startMonth; m < months.length; m++) {
      if (emptyMonths >= 3) break;
      const month = months[m];
      const mi = m;

      // Each month is one step — paginated internally (~1-4 pages for <1K customers)
      const synced: number = await step.run(`month-${mi}`, () =>
        syncCustomerMonth(workspace_id, month.start, month.end)
      );

      customersSynced += synced;
      emptyMonths = synced === 0 ? emptyMonths + 1 : 0;

      await step.run(`progress-${mi}`, () =>
        updateJob({ synced_customers: customersSynced, current_month: m + 1, last_completed_month: m + 1 })
      );
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

// ── Sync Orders (paginated, month by month) ──
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

    const resumeInfo: { startMonth: number; previousSynced: number } = await step.run("check-resume", async () => {
      const { data: job } = await admin.from("sync_jobs").select("last_completed_month, synced_orders").eq("id", job_id).single();
      return { startMonth: job?.last_completed_month || 0, previousSynced: job?.synced_orders || 0 };
    });

    const counts = await step.run("get-counts", async () => {
      await updateJob({ status: "running", phase: "orders", total_months: 36 });
      return getShopifyCounts(workspace_id);
    });

    await step.run("update-counts", async () => {
      await updateJob({ total_orders: counts.orders });
    });

    const months = getMonthRanges(36);
    let ordersSynced = resumeInfo.previousSynced;
    let emptyMonths = 0;

    for (let m = resumeInfo.startMonth; m < months.length; m++) {
      if (emptyMonths >= 3) break;
      const month = months[m];
      const mi = m;

      const synced: number = await step.run(`month-${mi}`, () =>
        syncOrderMonth(workspace_id, month.start, month.end)
      );

      ordersSynced += synced;
      emptyMonths = synced === 0 ? emptyMonths + 1 : 0;

      await step.run(`progress-${mi}`, () =>
        updateJob({ synced_orders: ordersSynced, current_month: m + 1, last_completed_month: m + 1 })
      );
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
