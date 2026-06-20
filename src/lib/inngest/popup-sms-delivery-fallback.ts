/**
 * Popup-coupon SMS-delivery fallback.
 *
 * The phone step (`/api/popup/claim`) texts the customer their WELCOME code
 * and stamps `storefront_leads.sms_status='queued'`. The Twilio status
 * callback advances that to `delivered` — OR the message never delivers:
 * it can sit at `queued` forever (A2P-registration / carrier-filtering
 * problems produce no terminal callback) or come back `undelivered`/`failed`.
 * In any of those cases the customer never sees the code by SMS.
 *
 * This job fires off the phone step's SMS send: it waits a delivery window,
 * then — if the SMS still hasn't reached `delivered` and the lead consented
 * to email — emails the code as a backup. Idempotent + deduped against the
 * abandonment fallback via the shared `fallback_emailed_at` guard, so a lead
 * gets at most one fallback email total.
 *
 * Triggered by ticket 8e9e325e (Harvey Kletz, 2026-06-20): his WELCOME SMS
 * sat at `queued`, `fallback_emailed_at` was null, and he never got the text.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

// How long we give the SMS to reach `delivered` before emailing as backup.
const DELIVERY_WINDOW = "10m";

export const popupSmsDeliveryFallback = inngest.createFunction(
  {
    id: "popup-sms-delivery-fallback",
    retries: 2,
    triggers: [{ event: "popup/sms-coupon-sent" }],
  },
  async ({ event, step }) => {
    const { workspace_id, customer_id, email, coupon_code, product_handle } = event.data as {
      workspace_id: string;
      customer_id: string;
      email: string;
      coupon_code: string;
      product_handle?: string | null;
    };

    // Give the SMS time to deliver (status callback flips sms_status).
    await step.sleep("wait-for-sms-delivery", DELIVERY_WINDOW);

    return step.run("email-coupon-if-sms-undelivered", async () => {
      const admin = createAdminClient();
      const { data: lead } = await admin
        .from("storefront_leads")
        .select("coupon_code_issued, sms_status, fallback_emailed_at, email_consent_at, email")
        .eq("workspace_id", workspace_id)
        .eq("customer_id", customer_id)
        .maybeSingle();

      if (!lead) return { skipped: "no_lead" };
      // SMS delivered → the code reached them by text. Nothing to do.
      if (lead.sms_status === "delivered") return { skipped: "sms_delivered" };
      // Already emailed (this path or the abandonment path) → no double-send.
      if (lead.fallback_emailed_at) return { skipped: "already_sent" };
      // No email consent → we can't email them the backup.
      if (!lead.email_consent_at) return { skipped: "no_email_consent" };

      const code = (lead.coupon_code_issued as string | null) || coupon_code || null;
      if (!code) return { skipped: "no_coupon" };
      const toEmail = (lead.email as string | null) || email;
      if (!toEmail) return { skipped: "no_email" };

      const { sendPopupCouponEmail } = await import("@/lib/popup/coupon-email");
      const result = await sendPopupCouponEmail({
        workspaceId: workspace_id,
        customerId: customer_id,
        email: toEmail,
        couponCode: code,
        productHandle: product_handle,
      });
      return { sms_status: lead.sms_status || "unknown", ...result };
    });
  },
);
