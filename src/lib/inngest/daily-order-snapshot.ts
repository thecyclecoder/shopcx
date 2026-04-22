/**
 * Daily Order Snapshot — runs at 1 AM Central (6 AM UTC) and computes
 * order counts + revenue for the previous day, categorized by type.
 *
 * Also validates against Shopify GraphQL to catch sync gaps.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

type SourceCategory = "recurring" | "checkout" | "replacement" | "unknown";

export const dailyOrderSnapshot = inngest.createFunction(
  {
    id: "daily-order-snapshot",
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 6 * * *" },  // 1 AM Central = 6 AM UTC
      { event: "snapshot/daily-orders" },
    ],
  },
  async ({ event, step }) => {
    const admin = createAdminClient();

    const workspaces = await step.run("get-workspaces", async () => {
      const { data } = await admin.from("workspaces")
        .select("id, order_source_mapping, shopify_access_token_encrypted, shopify_myshopify_domain")
        .not("shopify_myshopify_domain", "is", null);
      return data || [];
    });

    for (const ws of workspaces) {
      await step.run(`snapshot-${ws.id.slice(0, 8)}`, async () => {
        // Determine store timezone — default Central
        // The snapshot_date comes from event data or defaults to yesterday
        const overrideDate = (event.data as Record<string, unknown>)?.date as string | undefined;

        // Calculate yesterday in Central time
        // Central = UTC-5 (CDT) or UTC-6 (CST). Use -5 for April (CDT).
        const centralOffsetHours = 5; // CDT
        const now = new Date();
        const centralNow = new Date(now.getTime() - centralOffsetHours * 3600000);
        const centralYesterday = new Date(centralNow);
        centralYesterday.setDate(centralYesterday.getDate() - 1);

        const snapshotDate = overrideDate || centralYesterday.toISOString().slice(0, 10);

        // UTC boundaries for this Central date
        const utcStart = new Date(snapshotDate + "T00:00:00Z");
        utcStart.setHours(utcStart.getHours() + centralOffsetHours); // midnight Central → UTC
        const utcEnd = new Date(utcStart.getTime() + 24 * 3600000);

        const utcStartISO = utcStart.toISOString();
        const utcEndISO = utcEnd.toISOString();

        // Build source category map from workspace config
        const sourceMapping = (ws.order_source_mapping || {}) as Record<string, string>;
        function categorize(sourceName: string): SourceCategory {
          const mapped = sourceMapping[sourceName];
          if (mapped === "recurring") return "recurring";
          if (mapped === "checkout") return "checkout";
          if (mapped === "replacement") return "replacement";
          // Fallback heuristics
          if (sourceName.includes("subscription")) return "recurring";
          if (sourceName === "web" || sourceName === "pos") return "checkout";
          if (sourceName === "shopify_draft_order") return "replacement";
          return "unknown";
        }

        // Query our DB
        const dbOrders: { source_name: string; total_cents: number; tags: string | string[] | null }[] = [];
        let offset = 0;
        while (true) {
          const { data } = await admin.from("orders")
            .select("source_name, total_cents, tags")
            .eq("workspace_id", ws.id)
            .gte("created_at", utcStartISO)
            .lt("created_at", utcEndISO)
            .range(offset, offset + 999);
          if (!data?.length) break;
          dbOrders.push(...data.map(o => ({
            source_name: o.source_name || "unknown",
            total_cents: o.total_cents || 0,
            tags: o.tags,
          })));
          if (data.length < 1000) break;
          offset += 1000;
        }

        // Categorize
        let recurringCount = 0, recurringRevenue = 0;
        let newSubCount = 0, newSubRevenue = 0;
        let oneTimeCount = 0, oneTimeRevenue = 0;
        let replacementCount = 0, replacementRevenue = 0;

        for (const o of dbOrders) {
          const category = categorize(o.source_name);
          const tagList = Array.isArray(o.tags) ? o.tags : typeof o.tags === "string" ? [o.tags] : [];
          const hasFirstSub = tagList.some(t => t.toLowerCase().includes("first subscription"));

          if (category === "recurring") {
            recurringCount++;
            recurringRevenue += o.total_cents;
          } else if (category === "checkout") {
            if (hasFirstSub) {
              newSubCount++;
              newSubRevenue += o.total_cents;
            } else {
              oneTimeCount++;
              oneTimeRevenue += o.total_cents;
            }
          } else if (category === "replacement") {
            replacementCount++;
            replacementRevenue += o.total_cents;
          } else {
            // Unknown — treat as one-time
            oneTimeCount++;
            oneTimeRevenue += o.total_cents;
          }
        }

        // Totals exclude replacements
        const totalCount = recurringCount + newSubCount + oneTimeCount;
        const totalRevenue = recurringRevenue + newSubRevenue + oneTimeRevenue;
        const dbTotalWithReplacements = totalCount + replacementCount;

        // Validate against Shopify GraphQL
        let shopifyCount: number | null = null;
        let shopifyMismatch = false;

        if (ws.shopify_access_token_encrypted && ws.shopify_myshopify_domain) {
          try {
            const shopToken = decrypt(ws.shopify_access_token_encrypted);
            const shop = ws.shopify_myshopify_domain;

            let count = 0;
            let shopCursor: string | null = null;
            let hasMore = true;
            while (hasMore) {
              const after = shopCursor ? `, after: "${shopCursor}"` : "";
              const gql = `{ orders(first: 100, query: "created_at:${snapshotDate}"${after}) { edges { cursor node { name } } pageInfo { hasNextPage } } }`;
              const gqlRes = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
                method: "POST",
                headers: { "X-Shopify-Access-Token": shopToken, "Content-Type": "application/json" },
                body: JSON.stringify({ query: gql }),
              });
              if (!gqlRes.ok) break;
              const gqlData = (await gqlRes.json()) as { data?: { orders?: { edges?: { cursor: string; node: { name: string } }[]; pageInfo?: { hasNextPage: boolean } } } };
              const gqlEdges = gqlData.data?.orders?.edges || [];
              count += gqlEdges.length;
              shopCursor = gqlEdges.length ? gqlEdges[gqlEdges.length - 1].cursor : null;
              hasMore = gqlData.data?.orders?.pageInfo?.hasNextPage || false;
            }
            shopifyCount = count;
            // Compare against total including replacements since Shopify counts all orders
            shopifyMismatch = count !== dbTotalWithReplacements;
          } catch {
            // Non-fatal — snapshot still saves without validation
          }
        }


        // Upsert snapshot
        await admin.from("daily_order_snapshots").upsert({
          workspace_id: ws.id,
          snapshot_date: snapshotDate,
          store_timezone: "America/Chicago",
          recurring_count: recurringCount,
          recurring_revenue_cents: recurringRevenue,
          new_subscription_count: newSubCount,
          new_subscription_revenue_cents: newSubRevenue,
          one_time_count: oneTimeCount,
          one_time_revenue_cents: oneTimeRevenue,
          replacement_count: replacementCount,
          replacement_revenue_cents: replacementRevenue,
          total_count: totalCount,
          total_revenue_cents: totalRevenue,
          shopify_count: shopifyCount,
          shopify_mismatch: shopifyMismatch,
          utc_start: utcStartISO,
          utc_end: utcEndISO,
          computed_at: new Date().toISOString(),
        }, { onConflict: "workspace_id,snapshot_date" });

        // Alert on mismatch
        if (shopifyMismatch && shopifyCount !== null) {
          await admin.from("dashboard_notifications").insert({
            workspace_id: ws.id,
            type: "system",
            title: `Order sync mismatch on ${snapshotDate}`,
            body: `DB has ${dbTotalWithReplacements} orders but Shopify has ${shopifyCount} for ${snapshotDate}. Difference: ${Math.abs(dbTotalWithReplacements - shopifyCount)} orders.`,
            link: "/dashboard/orders",
            metadata: { type: "order_sync_mismatch", date: snapshotDate, db_count: dbTotalWithReplacements, shopify_count: shopifyCount },
          });
        }

        // Alert if zero orders (something is broken)
        if (totalCount === 0) {
          await admin.from("dashboard_notifications").insert({
            workspace_id: ws.id,
            type: "system",
            title: `No orders recorded on ${snapshotDate}`,
            body: `Zero orders found in the database for ${snapshotDate}. This likely indicates a webhook sync issue.`,
            link: "/dashboard/orders",
            metadata: { type: "missing_order_data", date: snapshotDate },
          });
        }

        // Check for gaps — alert if previous day is missing
        const prevDate = new Date(snapshotDate);
        prevDate.setDate(prevDate.getDate() - 1);
        const prevDateStr = prevDate.toISOString().slice(0, 10);
        const { data: prevSnapshot } = await admin.from("daily_order_snapshots")
          .select("id")
          .eq("workspace_id", ws.id)
          .eq("snapshot_date", prevDateStr)
          .maybeSingle();

        if (!prevSnapshot) {
          await admin.from("dashboard_notifications").insert({
            workspace_id: ws.id,
            type: "system",
            title: `Missing snapshot for ${prevDateStr}`,
            body: `No daily order snapshot exists for ${prevDateStr}. This day may need to be backfilled.`,
            link: "/dashboard/orders",
            metadata: { type: "missing_snapshot", date: prevDateStr },
          });
        }

        return {
          date: snapshotDate,
          db_count: totalCount,
          shopify_count: shopifyCount,
          mismatch: shopifyMismatch,
          recurring: recurringCount,
          new_sub: newSubCount,
          one_time: oneTimeCount,
          replacement: replacementCount,
        };
      });
    }

    return { workspaces: workspaces.length };
  },
);
