/**
 * Weekly cron: re-scan Amazon SP-API for resellers competing on our
 * ASINs and update the known_resellers table. New rows are inserted
 * with status='unverified' so admins can review before the fraud rule
 * (#38) starts blocking matching addresses.
 *
 * Runs Mondays at 6 AM Central (12:00 UTC). The discovery work itself
 * lives in src/lib/known-resellers.ts for reuse from the CLI script.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { discoverResellers } from "@/lib/known-resellers";

export const resellerDiscoveryWeeklyCron = inngest.createFunction(
  {
    id: "reseller-discovery-weekly",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 12 * * 1" }], // Mondays 12:00 UTC = 6/7 AM Central
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaces = await step.run("list-workspaces", async () => {
      const { data } = await admin
        .from("workspaces")
        .select("id, name")
        .not("shopify_access_token_encrypted", "is", null);
      return data || [];
    });

    const summary: { workspace: string; asins: number; discovered: number; updated: number }[] = [];
    for (const ws of workspaces) {
      const result = await step.run(`discover-${ws.id.slice(0, 8)}`, async () => {
        const { data: conn } = await admin
          .from("amazon_connections")
          .select("id")
          .eq("workspace_id", ws.id)
          .eq("is_active", true)
          .maybeSingle();
        if (!conn) return { asinsScanned: 0, sellersDiscovered: 0, sellersUpdated: 0 };
        return await discoverResellers(ws.id);
      });
      summary.push({
        workspace: ws.name,
        asins: result.asinsScanned,
        discovered: result.sellersDiscovered,
        updated: result.sellersUpdated,
      });

      // Notify admins when new resellers are discovered. They're
      // inserted as status='active' immediately (we have no
      // distributors, so anyone selling our product is unauthorized);
      // the notification is heads-up, not approval gate.
      if (result.sellersDiscovered > 0) {
        await step.run(`notify-${ws.id.slice(0, 8)}`, async () => {
          await admin.from("dashboard_notifications").insert({
            workspace_id: ws.id,
            kind: "fraud_alert",
            title: `${result.sellersDiscovered} new Amazon reseller${result.sellersDiscovered === 1 ? "" : "s"} added to fraud list`,
            body: `Their addresses are now blocked by the amazon_reseller fraud rule. View at /dashboard/settings/fraud-detection/resellers.`,
            link: "/dashboard/settings/fraud-detection/resellers",
            severity: "info",
          });
        });
      }
    }

    return summary;
  },
);
