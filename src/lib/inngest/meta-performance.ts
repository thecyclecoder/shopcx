// Inngest functions for Meta performance ingestion (Storefront Iteration Engine
// Phase 1). Mirrors campaign/adset/ad structure + daily object-grain insights
// into meta_campaigns/meta_adsets/meta_ads/meta_insights_daily, then reconciles
// against the existing daily_meta_ad_spend account rollup.

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMetaUserToken } from "@/lib/meta-ads";
import { ingestMetaPerformance } from "@/lib/meta/performance";
import { refreshVariantAttribution } from "@/lib/meta/attribution";
import { refreshScorecards } from "@/lib/meta/scorecards";

// ── meta/sync-performance — ingest one account ──
export const metaSyncPerformance = inngest.createFunction(
  {
    id: "meta-sync-performance",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/sync-performance" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, meta_account_id, incremental_days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      meta_account_id: string;
      incremental_days?: number;
    };

    const token = await step.run("get-token", async () => {
      const t = await getMetaUserToken(workspace_id);
      if (!t) throw new Error("No active Meta token for workspace");
      return t;
    });

    const result = await step.run("ingest", async () => {
      return ingestMetaPerformance(
        { workspaceId: workspace_id, adAccountId: ad_account_id, metaAccountId: meta_account_id, accessToken: token },
        { incrementalDays: incremental_days },
      );
    });

    // Surface reconciliation drift loudly (Phase 5 will route this to run-records/alerts).
    if (result.reconcile.drift.length) {
      console.warn(
        `[meta-performance] spend drift vs daily_meta_ad_spend for account ${ad_account_id}:`,
        JSON.stringify(result.reconcile.drift),
      );
    }

    // Phase 2 — refresh variant attribution now that insights are fresh (the
    // ad-level spend it allocates was just upserted above). Phase 5 will fold this
    // into the full daily orchestration; firing it here keeps the data current.
    await step.run("attribution-refresh", async () => {
      await inngest.send({
        name: "meta/attribution-refresh",
        data: { workspace_id, ad_account_id },
      });
    });

    return { status: "complete", ...result };
  },
);

// ── meta/attribution-refresh — Phase 2 per-(meta_ad_id, variant, day) rollup ──
export const metaAttributionRefresh = inngest.createFunction(
  {
    id: "meta-attribution-refresh",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/attribution-refresh" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, incremental_days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      incremental_days?: number;
    };

    const result = await step.run("compute", async () => {
      return refreshVariantAttribution(
        { workspaceId: workspace_id, adAccountId: ad_account_id },
        { incrementalDays: incremental_days },
      );
    });

    // Surface the coverage metric loudly (Phase 5 will route to run-records/alerts).
    console.log(
      `[meta-attribution] account ${ad_account_id} variant_attribution_coverage=${result.coverage.variant_attribution_coverage}`,
      JSON.stringify(result.coverage),
    );

    // Phase 3 — refresh scorecards now that per-variant attribution is fresh. Phase
    // 5 folds this into the full daily orchestration; firing it here keeps the
    // controller's metrics current as soon as attribution lands.
    await step.run("scorecards-refresh", async () => {
      await inngest.send({
        name: "meta/scorecards-refresh",
        data: { workspace_id, ad_account_id },
      });
    });

    return { status: "complete", ...result };
  },
);

// ── meta/scorecards-refresh — Phase 3 deterministic metric rollups ──
export const metaScorecardsRefresh = inngest.createFunction(
  {
    id: "meta-scorecards-refresh",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/scorecards-refresh" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, snapshot_date, window_days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      snapshot_date?: string;
      window_days?: number;
    };

    const result = await step.run("compute", async () => {
      return refreshScorecards(
        { workspaceId: workspace_id, adAccountId: ad_account_id },
        { snapshotDate: snapshot_date, windowDays: window_days },
      );
    });

    console.log(
      `[meta-scorecards] account ${ad_account_id} ${result.snapshotDate} rows=${result.rows} ` +
        `coverage=${result.variant_attribution_coverage}`,
      JSON.stringify(result.counts),
    );

    return { status: "complete", ...result };
  },
);

// ── Daily cron: ingest performance for all active accounts ──
export const metaPerformanceDailyCron = inngest.createFunction(
  {
    id: "meta-performance-daily",
    retries: 1,
    triggers: [{ cron: "30 11 * * *" }], // 6:30 AM Central — after meta-daily-sync (account spend rollup)
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
      await step.run(`trigger-perf-${acct.id}`, async () => {
        await inngest.send({
          name: "meta/sync-performance",
          data: {
            workspace_id: acct.workspace_id,
            ad_account_id: acct.id,
            meta_account_id: acct.meta_account_id,
          },
        });
      });
    }

    return { triggered: accounts.length };
  },
);
