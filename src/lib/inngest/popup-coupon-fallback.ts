/**
 * Smart-popup abandonment fallback (storefront-mvp Phase 4e).
 *
 * When a lead finishes the popup's EMAIL step (coupon minted) but never
 * completes the PHONE step, we still want to recover the lead's value —
 * so 5 minutes later we EMAIL them the code. We do NOT auto-apply it (no
 * validated mobile, and they've left), unlike the SMS path.
 *
 * Dedup guard: the email only fires if the phone step never completed
 * (`storefront_leads.sms_consent_at IS NULL`) AND we haven't already sent
 * the fallback — so a lead never gets both the SMS and the fallback email.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const popupCouponFallback = inngest.createFunction(
  {
    id: "popup-coupon-fallback",
    retries: 2,
    triggers: [{ event: "popup/email-lead-captured" }],
  },
  async ({ event, step }) => {
    const { workspace_id, customer_id, email, product_handle } = event.data as {
      workspace_id: string;
      customer_id: string;
      email: string;
      product_handle?: string | null;
    };

    // Give the customer 5 minutes to finish the phone step.
    await step.sleep("wait-for-phone-step", "5m");

    const result = await step.run("email-coupon-if-abandoned", async () => {
      const admin = createAdminClient();
      const { data: lead } = await admin
        .from("storefront_leads")
        .select("coupon_code_issued, sms_consent_at, fallback_emailed_at")
        .eq("workspace_id", workspace_id)
        .eq("customer_id", customer_id)
        .maybeSingle();

      // Phone step completed → SMS already delivered the code. Skip.
      // (If the SMS doesn't actually deliver, popup-sms-delivery-fallback
      // covers that case — it fires off the phone step's SMS send.)
      if (!lead || lead.sms_consent_at) return { skipped: "phone_completed" };
      // Already sent the fallback → don't double-send.
      if (lead.fallback_emailed_at) return { skipped: "already_sent" };
      const code = lead.coupon_code_issued as string | null;
      if (!code) return { skipped: "no_coupon" };

      const { sendPopupCouponEmail } = await import("@/lib/popup/coupon-email");
      return sendPopupCouponEmail({
        workspaceId: workspace_id,
        customerId: customer_id,
        email,
        couponCode: code,
        productHandle: product_handle,
      });
    });

    return result;
  },
);
