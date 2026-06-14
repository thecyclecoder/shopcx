import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * ONE-OFF operational gate for the Founder's VIP sale (June 2026).
 *
 * The Day-1 blast (campaign 2535fead…, send_date 2026-06-14) goes out today;
 * a Day-2 follow-up (campaign 14825ec4…, send_date 2026-06-15, "Only 1 day
 * left / Expires 11:59PM") should reach everyone who DIDN'T buy on Day 1.
 * Day-1 buyers don't exist until purchases land, so the exclusion can't be
 * computed at schedule time — this cron computes it the morning of the 15th.
 *
 * Fires 2026-06-15 12:00 UTC (~07:00 ET, ~1h before the earliest 9am-local
 * follow-up send). It: (1) finds everyone who redeemed FOUNDERVIP since the
 * Day-1 send, (2) tags them `foundervip_d1_buyer`, (3) sets that tag as an
 * excluded segment on the follow-up, (4) launches the follow-up.
 *
 * Self-disabling: no-op unless the follow-up is still `draft`, so the annual
 * cron re-fire next June 15 does nothing. Safe to delete after 2026-06-15.
 */

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FOLLOWUP_ID = "14825ec4-c168-42f0-98eb-bd434bb11f3e";
const DAY1_ID = "2535fead-b1df-465f-937c-1e67bbbf806a";
const COUPON = "FOUNDERVIP";
const BUYER_TAG = "foundervip_d1_buyer";

export const foundervipFollowupGate = inngest.createFunction(
  {
    id: "foundervip-followup-gate",
    retries: 2,
    concurrency: [{ limit: 1 }],
    // 2026-06-15 12:00 UTC (~07:00 ET). Annual re-fire is a guarded no-op.
    triggers: [{ cron: "0 12 15 6 *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Guard — only run while the follow-up is still a draft.
    const { data: camp } = await admin
      .from("sms_campaigns")
      .select("status")
      .eq("id", FOLLOWUP_ID)
      .maybeSingle();
    if (!camp || camp.status !== "draft") {
      return { skipped: `follow-up status=${camp?.status ?? "missing"}` };
    }

    // 1) Day-1 FOUNDERVIP buyers — coupon redemption OR UTM-attributed to Day 1.
    const buyerIds = await step.run("find-buyers", async () => {
      const ids = new Set<string>();
      const { data } = await admin
        .from("orders")
        .select("customer_id, discount_codes, attributed_utm_campaign")
        .eq("workspace_id", WS)
        .gte("created_at", "2026-06-14T00:00:00Z");
      for (const o of data || []) {
        if (!o.customer_id) continue;
        const arr = Array.isArray(o.discount_codes) ? o.discount_codes : [];
        const codes = arr
          .map((c) => (typeof c === "string" ? c : (c as { code?: string })?.code || ""))
          .map((s) => s.toUpperCase());
        if (codes.includes(COUPON) || o.attributed_utm_campaign === DAY1_ID) {
          ids.add(o.customer_id as string);
        }
      }
      return [...ids];
    });

    // 2) Tag buyers so the follow-up's excluded_segments suppresses them.
    await step.run("tag-buyers", async () => {
      for (let i = 0; i < buyerIds.length; i += 200) {
        const chunk = buyerIds.slice(i, i + 200);
        const { data: cs } = await admin.from("customers").select("id, segments").in("id", chunk);
        await Promise.all(
          (cs || []).map((c) => {
            const segs = new Set<string>(((c.segments as string[]) || []));
            if (segs.has(BUYER_TAG)) return Promise.resolve();
            segs.add(BUYER_TAG);
            return admin.from("customers").update({ segments: [...segs] }).eq("id", c.id);
          }),
        );
      }
      return buyerIds.length;
    });

    // 3) Exclude the buyer tag + launch the follow-up.
    await admin
      .from("sms_campaigns")
      .update({ excluded_segments: ["active_sub", BUYER_TAG] })
      .eq("id", FOLLOWUP_ID);
    await step.sendEvent("launch-followup", {
      name: "marketing/text-campaign.scheduled",
      data: { campaign_id: FOLLOWUP_ID },
    });
    await admin
      .from("sms_campaigns")
      .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
      .eq("id", FOLLOWUP_ID);

    return { buyers_excluded: buyerIds.length };
  },
);
