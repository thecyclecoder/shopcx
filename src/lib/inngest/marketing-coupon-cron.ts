/**
 * Daily cron that disables campaign coupons after their expiry
 * window passes. Keeps the active Shopify discount count from
 * growing forever — every campaign creates a code, and without
 * this they'd all stay live.
 *
 * Window: first_send_at + coupon_expires_days_after_send.
 * Disables in Shopify (sets endsAt = now) AND marks the campaign
 * with coupon_disabled_at so we don't re-process.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { disableCampaignCoupon } from "@/lib/marketing-coupons";

export const marketingCouponAutoDisable = inngest.createFunction(
  {
    id: "marketing-coupon-auto-disable",
    name: "Marketing — auto-disable expired campaign coupons",
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 10 * * *" }, // 5 AM Central daily
      { event: "marketing/coupon.disable-tick" },
    ],
  },
  async ({ step }) => {
    const due = await step.run("find-expired", async () => {
      const admin = createAdminClient();
      // Pull campaigns whose coupons are still active AND first_send_at
      // happened more than coupon_expires_days_after_send ago.
      // SQL-level filter saves us a fan-out.
      const { data } = await admin.from("sms_campaigns")
        .select("id, workspace_id, coupon_shopify_node_id, first_send_at, coupon_expires_days_after_send")
        .not("coupon_shopify_node_id", "is", null)
        .is("coupon_disabled_at", null)
        .not("first_send_at", "is", null);
      const expired = (data || []).filter((c) => {
        const days = c.coupon_expires_days_after_send || 21;
        const expiresAt = new Date(c.first_send_at).getTime() + days * 86_400_000;
        return expiresAt < Date.now();
      });
      return expired as Array<{ id: string; workspace_id: string; coupon_shopify_node_id: string }>;
    });

    if (due.length === 0) return { disabled: 0 };

    let disabled = 0;
    for (const c of due) {
      const ok = await step.run(`disable-${c.id}`, async () => {
        const result = await disableCampaignCoupon(c.workspace_id, c.coupon_shopify_node_id);
        if (!result.success) return false;
        const admin = createAdminClient();
        await admin
          .from("sms_campaigns")
          .update({ coupon_disabled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", c.id);
        return true;
      });
      if (ok) disabled++;
    }
    return { disabled, total_due: due.length };
  },
);
