// Inngest functions for Meta ad spend sync

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { syncMetaAdSpend } from "@/lib/meta/sync-spend";

// ── meta/sync-spend ──
export const metaSyncSpend = inngest.createFunction(
  {
    id: "meta-sync-spend",
    retries: 2,
    concurrency: [{ limit: 2, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/sync-spend" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, meta_account_id, days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      meta_account_id: string;
      days?: number;
    };

    const admin = createAdminClient();

    // Get access token from connection
    const token = await step.run("get-token", async () => {
      const { data: conn } = await admin
        .from("meta_connections")
        .select("access_token_encrypted")
        .eq("workspace_id", workspace_id)
        .eq("is_active", true)
        .single();
      if (!conn) throw new Error("No active Meta connection");
      return decrypt(conn.access_token_encrypted);
    });

    const syncDays = Math.min(days || 30, 90);
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - syncDays * 86400000).toISOString().slice(0, 10);

    const result = await step.run("sync-spend", async () => {
      return syncMetaAdSpend({
        workspaceId: workspace_id,
        adAccountId: ad_account_id,
        metaAccountId: meta_account_id,
        accessToken: token,
        startDate,
        endDate,
      });
    });

    return { status: "complete", ...result };
  }
);

// ── Daily cron: sync yesterday's spend for all active accounts ──
export const metaDailySyncCron = inngest.createFunction(
  {
    id: "meta-daily-sync",
    retries: 1,
    triggers: [{ cron: "0 11 * * *" }], // 6 AM Central
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const accounts = await step.run("find-active-accounts", async () => {
      const { data } = await admin
        .from("meta_ad_accounts")
        .select("id, workspace_id, meta_account_id")
        .eq("is_active", true);
      return data || [];
    });

    for (const acct of accounts) {
      await step.run(`trigger-sync-${acct.id}`, async () => {
        await inngest.send({
          name: "meta/sync-spend",
          data: {
            workspace_id: acct.workspace_id,
            ad_account_id: acct.id,
            meta_account_id: acct.meta_account_id,
            days: 3, // Last 3 days to catch late-reporting
          },
        });
      });
    }

    return { triggered: accounts.length };
  }
);
