// Inngest cron: keep today's Amazon + Meta snapshots fresh (every 5 min)

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { requestReport, pollReportStatus, downloadReport, processOrderReport } from "@/lib/amazon/sync-orders";
import { syncMetaAdSpend } from "@/lib/meta/sync-spend";

export const todaySyncCron = inngest.createFunction(
  {
    id: "today-sync",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);

    // ── Amazon: pull today's report and update snapshot ──
    const amzResult = await step.run("sync-amazon-today", async () => {
      const { data: conn } = await admin
        .from("amazon_connections")
        .select("id, workspace_id, marketplace_id")
        .eq("is_active", true)
        .maybeSingle();

      if (!conn) return { amazon: "no_connection" };

      try {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const reportId = await requestReport(conn.id, conn.marketplace_id, today + "T00:00:00Z", tomorrow.toISOString().slice(0, 10) + "T00:00:00Z");

        let documentId: string | null = null;
        for (let i = 0; i < 30; i++) {
          const status = await pollReportStatus(conn.id, conn.marketplace_id, reportId);
          if (status.status === "DONE") { documentId = status.documentId; break; }
          if (status.status === "CANCELLED" || status.status === "FATAL") break;
          await new Promise(r => setTimeout(r, 3000));
        }

        if (!documentId) return { amazon: "report_timeout" };

        const tsv = await downloadReport(conn.id, conn.marketplace_id, documentId);
        const result = await processOrderReport({
          workspaceId: conn.workspace_id,
          connectionId: conn.id,
          reportTsv: tsv,
        });

        return { amazon: "synced", orders: result.orderCount };
      } catch (err) {
        console.error("[Today Sync] Amazon error:", err);
        return { amazon: "error" };
      }
    });

    // ── Meta: pull today's spend for all active accounts ──
    const metaResult = await step.run("sync-meta-today", async () => {
      const { data: conn } = await admin
        .from("meta_connections")
        .select("access_token_encrypted, workspace_id")
        .eq("is_active", true)
        .maybeSingle();

      if (!conn?.access_token_encrypted) return { meta: "no_connection" };

      const token = decrypt(conn.access_token_encrypted);
      const { data: accounts } = await admin
        .from("meta_ad_accounts")
        .select("id, meta_account_id")
        .eq("workspace_id", conn.workspace_id)
        .eq("is_active", true);

      let totalDays = 0;
      for (const acct of accounts || []) {
        try {
          const result = await syncMetaAdSpend({
            workspaceId: conn.workspace_id,
            adAccountId: acct.id,
            metaAccountId: acct.meta_account_id,
            accessToken: token,
            startDate: today,
            endDate: today,
          });
          totalDays += result.daysProcessed;
        } catch (err) {
          console.error(`[Today Sync] Meta error for ${acct.meta_account_id}:`, err);
        }
      }

      return { meta: "synced", accounts: accounts?.length || 0, days: totalDays };
    });

    return { today, ...amzResult, ...metaResult };
  }
);
