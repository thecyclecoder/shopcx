// Inngest functions for Amazon SP-API sync

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { requestReport, pollReportStatus, downloadReport, processOrderReport } from "@/lib/amazon/sync-orders";
import { spApiRequest, isLwaCredentialsExpiredError } from "@/lib/amazon/auth";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

// ── amazon/sync-orders ──
// Triggered manually or by daily cron. Requests report → polls → processes.
export const amazonSyncOrders = inngest.createFunction(
  {
    id: "amazon-sync-orders",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.connection_id" }],
    triggers: [{ event: "amazon/sync-orders" }],
  },
  async ({ event, step }) => {
    const { workspace_id, connection_id, days } = event.data as {
      workspace_id: string;
      connection_id: string;
      days?: number;
    };

    const admin = createAdminClient();

    // Load connection
    const conn = await step.run("load-connection", async () => {
      const { data } = await admin
        .from("amazon_connections")
        .select("id, marketplace_id, is_active")
        .eq("id", connection_id)
        .single();
      return data;
    });

    if (!conn?.is_active) return { status: "skipped", reason: "inactive" };

    // Calculate date range — DAY-ALIGNED (UTC), never clock-relative.
    // `processOrderReport` upserts whole (snapshot_date, order_bucket) rows, so a
    // clock-time window would hand it a PARTIAL first day (only the slice after
    // the current time) and clobber that day's complete row with it. Snapping the
    // start to 00:00Z and the end to tomorrow 00:00Z keeps every day in the
    // window whole, so each upsert re-asserts a full day.
    const syncDays = Math.min(days || 30, 90);
    const todayUtcMs = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const startDate = new Date(todayUtcMs - syncDays * 86400000).toISOString();
    const endDate = new Date(todayUtcMs + 86400000).toISOString();

    // Request report — wrapped so an expired LWA client_secret (Amazon rotates
    // them on a rolling window) short-circuits into a graceful `credentials_expired`
    // status instead of throwing and burning the retry/cron on the same 401. This
    // is the SP-API chokepoint: `spApiRequest` funnels every call through
    // `getAccessToken`, so the first LWA-expired error surfaces here.
    let reportId: string;
    try {
      reportId = await step.run("request-report", async () => {
        return requestReport(connection_id, conn.marketplace_id, startDate, endDate);
      });
    } catch (err) {
      if (!isLwaCredentialsExpiredError(err)) throw err;
      return await step.run("handle-lwa-expired", async () => {
        // (a) Deactivate the connection so the daily cron stops re-hitting the
        // dead credential (the cron filters on `is_active = true`).
        await admin
          .from("amazon_connections")
          .update({ is_active: false })
          .eq("id", connection_id);

        // (b) File ONE open dashboard notification asking the workspace owner
        // to rotate their LWA client_secret. Deduped by metadata.dedupe_key —
        // the DB has a UNIQUE partial index on ((metadata->>'dedupe_key'))
        // WHERE dismissed = false, so a concurrent second insert would 23505.
        const dedupeKey = `amazon:lwa_expired:${connection_id}`;
        const { data: prior } = await admin
          .from("dashboard_notifications")
          .select("id")
          .eq("workspace_id", workspace_id)
          .eq("metadata->>dedupe_key", dedupeKey)
          .eq("dismissed", false)
          .limit(1);
        if ((prior ?? []).length === 0) {
          await admin.from("dashboard_notifications").insert({
            workspace_id,
            type: "system",
            title: "Amazon LWA client secret expired — rotate to resume sync",
            body:
              "Amazon has rotated the LWA app client secret on your Seller Central " +
              "app. The stored secret is rejected at every SP-API request (401 " +
              "'The LWA secret token you provided has expired'), so we deactivated " +
              "this Amazon connection to stop the daily sync from re-hitting it. " +
              "Generate a new client secret in Seller Central (Develop Apps → your " +
              "app → LWA credentials), paste it into the ShopCX integration UI, " +
              "then re-enable the connection.",
            metadata: {
              routed_to_function: "platform",
              escalation_kind: "amazon_lwa_expired",
              dedupe_key: dedupeKey,
              amazon_connection_id: connection_id,
            },
            read: false,
            dismissed: false,
          });
        }

        // (c) Graceful terminal status — the function completes cleanly so the
        // error feed stops burning on repeat 401s from the same dead credential.
        return { status: "credentials_expired", reason: "lwa_client_secret_expired" };
      });
    }

    // Poll until ready (max 60 attempts × 5s = 5 min)
    let documentId: string | null = null;
    for (let i = 0; i < 60; i++) {
      const result = await step.run(`poll-${i}`, async () => {
        return pollReportStatus(connection_id, conn.marketplace_id, reportId);
      });

      if (result.status === "DONE") {
        documentId = result.documentId;
        break;
      }
      if (result.status === "CANCELLED" || result.status === "FATAL") {
        return { status: "failed", reason: `Report ${result.status}` };
      }

      await step.sleep(`poll-wait-${i}`, "5s");
    }

    if (!documentId) return { status: "failed", reason: "Report timed out" };

    // Download and process
    const reportTsv = await step.run("download-report", async () => {
      return downloadReport(connection_id, conn.marketplace_id, documentId!);
    });

    const result = await step.run("process-report", async () => {
      return processOrderReport({
        workspaceId: workspace_id,
        connectionId: connection_id,
        reportTsv,
        // Same day-aligned window the report was requested for, so the prune can
        // clear a covered day whose orders all cancelled since the last sync.
        windowStart: startDate.slice(0, 10),
        windowEnd: endDate.slice(0, 10),
      });
    });

    return { status: "complete", ...result };
  }
);

// ── amazon/sync-asins ──
// Syncs product catalog from merchant listings report
export const amazonSyncAsins = inngest.createFunction(
  {
    id: "amazon-sync-asins",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.connection_id" }],
    triggers: [{ event: "amazon/sync-asins" }],
  },
  async ({ event, step }) => {
    const { workspace_id, connection_id } = event.data as {
      workspace_id: string;
      connection_id: string;
    };

    const admin = createAdminClient();

    const conn = await step.run("load-connection", async () => {
      const { data } = await admin
        .from("amazon_connections")
        .select("id, marketplace_id, is_active")
        .eq("id", connection_id)
        .single();
      return data;
    });

    if (!conn?.is_active) return { status: "skipped", reason: "inactive" };

    // Request merchant listings report
    const reportId = await step.run("request-asin-report", async () => {
      const res = await spApiRequest(connection_id, conn.marketplace_id, "POST", "/reports/2021-06-30/reports", {
        reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
        marketplaceIds: [conn.marketplace_id],
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`ASIN report request failed: ${JSON.stringify(data)}`);
      return data.reportId as string;
    });

    // Poll
    let documentId: string | null = null;
    for (let i = 0; i < 60; i++) {
      const result = await step.run(`asin-poll-${i}`, async () => {
        return pollReportStatus(connection_id, conn.marketplace_id, reportId);
      });
      if (result.status === "DONE") { documentId = result.documentId; break; }
      if (result.status === "CANCELLED" || result.status === "FATAL") {
        return { status: "failed", reason: `Report ${result.status}` };
      }
      await step.sleep(`asin-poll-wait-${i}`, "5s");
    }

    if (!documentId) return { status: "failed", reason: "Report timed out" };

    // Download and parse
    const result = await step.run("process-asin-report", async () => {
      const res = await spApiRequest(connection_id, conn.marketplace_id, "GET", `/reports/2021-06-30/documents/${documentId}`);
      const docData = await res.json();
      if (!docData.url) throw new Error("No download URL");

      const reportRes = await fetch(docData.url);
      const tsv = await reportRes.text();

      const lines = tsv.split("\n");
      if (lines.length < 2) return { synced: 0 };

      const headers = lines[0].split("\t");
      const idx = (name: string) => headers.indexOf(name);
      const titleIdx = idx("item-name");
      const skuIdx = idx("seller-sku");
      const asinIdx = idx("asin1");
      const imageIdx = idx("image-url");
      const statusIdx = idx("status");

      let synced = 0;
      const seenAsins = new Set<string>();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split("\t");

        const asin = cols[asinIdx]?.trim();
        if (!asin || seenAsins.has(asin)) continue;
        seenAsins.add(asin);

        const status = cols[statusIdx]?.trim() || "Active";

        await admin.from("amazon_asins").upsert({
          workspace_id,
          amazon_connection_id: connection_id,
          asin,
          sku: cols[skuIdx]?.trim() || null,
          title: cols[titleIdx]?.trim() || null,
          image_url: cols[imageIdx]?.trim() || null,
          status,
          updated_at: new Date().toISOString(),
        }, { onConflict: "amazon_connection_id,asin" });
        synced++;
      }

      // Mark ASINs not in report as inactive
      await admin.from("amazon_asins")
        .update({ status: "Inactive", updated_at: new Date().toISOString() })
        .eq("amazon_connection_id", connection_id)
        .not("asin", "in", `(${[...seenAsins].map(a => `'${a}'`).join(",")})`);

      return { synced };
    });

    return { status: "complete", ...result };
  }
);

// ── Daily cron: sync a 30-day rolling window for all active connections ──
export const amazonDailySyncCron = inngest.createFunction(
  {
    id: "amazon-daily-sync",
    retries: 1,
    triggers: [{ cron: "0 10 * * *" }], // 5 AM Central
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const connections = await step.run("find-active-connections", async () => {
      const { data } = await admin
        .from("amazon_connections")
        .select("id, workspace_id")
        .eq("is_active", true);
      return data || [];
    });

    for (const conn of connections) {
      await step.run(`trigger-sync-${conn.id}`, async () => {
        await inngest.send({
          name: "amazon/sync-orders",
          data: {
            workspace_id: conn.workspace_id,
            connection_id: conn.id,
            // Amazon keeps materializing orders well past the order date — SnS
            // renewals and Pending→Shipped transitions in particular. A day that
            // falls out of this window is frozen FOREVER at whatever the last
            // sync saw, so the window must outlast settlement, not just "late
            // reporting". Measured 2026-08-24: a 3-day window left Jun–Aug
            // understated by ~$18.1K of checkout revenue (July alone -18%).
            days: 30,
          },
        });
      });
    }

    const result = { triggered: connections.length };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("amazon-daily-sync", { ok: true, produced: result });
    });

    return result;
  }
);
