/**
 * Initial Revenue attribution recompute — UTM-precise version.
 *
 * Each Klaviyo SMS link carries utm_id=<klaviyo_campaign_id>. When a
 * recipient clicks through and orders, Shopify's Placed Order event
 * carries that URL on event_properties.$extra.landing_site, which
 * our events importer parses into klaviyo_events.attributed_klaviyo_campaign_id.
 *
 * So attribution becomes precise:
 *   - Initial Conversions = rows where attributed_klaviyo_campaign_id
 *     = this campaign AND source_name doesn't start with
 *     'subscription_contract' (defensive — Klaviyo UTMs shouldn't
 *     show up on auto-renewals anyway)
 *   - Sum value → Initial Revenue
 *
 * No 7-day window guessing, no false positives from coincidental
 * orders. Matches what Klaviyo's UI shows for "campaign conversions"
 * (modulo their attribution-window cap, which we don't enforce —
 * a buyer clicking the link 30 days after send still counts).
 *
 *   marketing/klaviyo-attribution.compute { workspace_id }
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

const PLACED_ORDER_METRIC = "VCkHuL";

export const klaviyoAttributionCompute = inngest.createFunction(
  {
    id: "klaviyo-attribution-compute",
    name: "Klaviyo — recompute Initial Revenue per campaign (UTM-precise)",
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
        .select("id, klaviyo_campaign_id")
        .eq("workspace_id", workspace_id);
      return (data || []) as Array<{ id: string; klaviyo_campaign_id: string }>;
    });

    if (campaigns.length === 0) return { computed: 0 };

    let computed = 0;
    for (const c of campaigns) {
      await step.run(`compute-${c.id}`, async () => {
        const admin = createAdminClient();
        // Pull every Placed Order event attributed via UTMs to this
        // campaign id. Defensive subscription filter: in practice
        // Klaviyo UTMs land on the storefront checkout, not the
        // subscription auto-renewal path, so this filter rarely
        // excludes anything — but we keep it so a manually-tagged
        // renewal can't sneak in.
        const { data: events } = await admin
          .from("klaviyo_events")
          .select("value, source_name, klaviyo_profile_id")
          .eq("workspace_id", workspace_id)
          .eq("klaviyo_metric_id", PLACED_ORDER_METRIC)
          .eq("attributed_klaviyo_campaign_id", c.klaviyo_campaign_id);

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
