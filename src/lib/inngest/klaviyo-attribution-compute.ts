/**
 * Initial Revenue attribution recompute.
 *
 * For each Klaviyo SMS campaign in our history table, scan the
 * klaviyo_events table for Placed Order events in the 7-day window
 * after send_time, EXCLUDING events whose source_name starts with
 * 'subscription_contract' (auto-renewals). Sum revenue + count
 * orders. Store as initial_conversions /
 * initial_conversion_value_cents / initial_average_order_value_cents
 * on the campaign row.
 *
 * This is the local equivalent of Klaviyo's UI-only "Initial Revenue"
 * conversion metric.
 *
 *   marketing/klaviyo-attribution.compute { workspace_id }
 *
 * Run after a fresh events import. Idempotent — overwrites prior
 * computed values with the latest numbers.
 *
 * Attribution window assumption: we count every non-subscription
 * Placed Order in the 7-day window after send_time. This is
 * "post-send revenue" rather than strict click-attributed revenue —
 * good enough for relative campaign comparison, intentionally
 * generous so we don't undercount.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

const ATTRIBUTION_WINDOW_DAYS = 7;
const PLACED_ORDER_METRIC = "VCkHuL";

export const klaviyoAttributionCompute = inngest.createFunction(
  {
    id: "klaviyo-attribution-compute",
    name: "Klaviyo — recompute Initial Revenue per campaign",
    concurrency: [{ limit: 1 }],
    retries: 2,
    triggers: [{ event: "marketing/klaviyo-attribution.compute" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string };

    const campaigns = await step.run("load-campaigns", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("klaviyo_sms_campaign_history")
        .select("id, send_time")
        .eq("workspace_id", workspace_id)
        .not("send_time", "is", null);
      return (data || []) as Array<{ id: string; send_time: string }>;
    });

    if (campaigns.length === 0) return { computed: 0 };

    let computed = 0;
    for (const c of campaigns) {
      await step.run(`compute-${c.id}`, async () => {
        const sendStart = new Date(c.send_time).toISOString();
        const sendEnd = new Date(
          new Date(c.send_time).getTime() + ATTRIBUTION_WINDOW_DAYS * 86_400_000,
        ).toISOString();

        const admin = createAdminClient();
        // Pull all non-subscription Placed Order events in the
        // attribution window. With <100K Placed Orders for 6 months
        // total, a per-campaign filtered query is fast.
        const { data: events } = await admin
          .from("klaviyo_events")
          .select("value, source_name")
          .eq("workspace_id", workspace_id)
          .eq("klaviyo_metric_id", PLACED_ORDER_METRIC)
          .gte("datetime", sendStart)
          .lt("datetime", sendEnd);

        let initialConversions = 0;
        let totalRevenue = 0;
        for (const e of events || []) {
          const src = (e.source_name as string | null) || "";
          if (src.startsWith("subscription_contract")) continue;
          const v = typeof e.value === "number" ? e.value : Number(e.value);
          if (!Number.isFinite(v)) continue;
          initialConversions++;
          totalRevenue += v;
        }

        const initialRevenueCents = Math.round(totalRevenue * 100);
        const initialAovCents = initialConversions > 0
          ? Math.round(initialRevenueCents / initialConversions)
          : null;

        await admin
          .from("klaviyo_sms_campaign_history")
          .update({
            initial_conversions: initialConversions,
            initial_conversion_value_cents: initialRevenueCents,
            initial_average_order_value_cents: initialAovCents,
            initial_revenue_computed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", c.id);
      });
      computed++;
    }
    return { computed };
  },
);
