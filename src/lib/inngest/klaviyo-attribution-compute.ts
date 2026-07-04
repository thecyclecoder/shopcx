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

    // Set-based recompute — ONE aggregate UPDATE across all campaigns via the
    // recompute_klaviyo_attribution() SQL function (migration 20260704180000). Replaces the
    // old per-campaign loop whose per-campaign klaviyo_events select was UNBOUNDED → silently
    // capped at PostgREST max-rows (1000) → any campaign with >1000 attributed orders
    // undercounted revenue. The function excludes subscription_contract renewals + null values
    // (identical to the old JS), and writes every campaign (LEFT JOIN → 0/0/null when no events).
    const computed = await step.run("recompute-attribution", async () => {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("recompute_klaviyo_attribution", {
        p_workspace_id: workspace_id,
        p_metric_id: PLACED_ORDER_METRIC,
      });
      if (error) throw new Error(`recompute_klaviyo_attribution(${workspace_id}) failed: ${error.message}`);
      return (data as number) ?? 0;
    });
    return { computed };
  },
);
