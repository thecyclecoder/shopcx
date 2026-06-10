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
      if (!lead || lead.sms_consent_at) return { skipped: "phone_completed" };
      // Already sent the fallback → don't double-send.
      if (lead.fallback_emailed_at) return { skipped: "already_sent" };
      const code = lead.coupon_code_issued as string | null;
      if (!code) return { skipped: "no_coupon" };

      const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspace_id).single();
      const { data: customer } = await admin.from("customers").select("first_name").eq("id", customer_id).maybeSingle();
      const first = (customer?.first_name as string) || "there";

      // Cross-device redeem link — drops them back on the PDP with the code
      // auto-applied (and the price tables reflecting it), no typing required.
      let redeemUrl: string | null = null;
      if (product_handle) {
        try {
          const { buildPopupRedeemUrl } = await import("@/lib/popup/redeem-link");
          redeemUrl = await buildPopupRedeemUrl(workspace_id, customer_id, code, product_handle);
        } catch (e) {
          console.warn("[popup-coupon-fallback] redeem link build failed:", e instanceof Error ? e.message : e);
        }
      }

      const cta = redeemUrl
        ? `<p><a href="${redeemUrl}" style="display:inline-block;background:#1f5e3a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;">Shop with my discount applied →</a></p>
<p style="font-size:12px;color:#888;">The discount is already applied — just complete checkout. This code is reserved for you and won't work for anyone else, so please don't share it.</p>`
        : `<p>Enter it at checkout to claim your savings — it's reserved just for you and won't work for anyone else, so please don't share it.</p>`;

      const body = `<p>Hi ${first}, here's the discount code you unlocked:</p>
<p style="font-size:22px;font-weight:700;letter-spacing:1px;">${code}</p>
${cta}
<p>The ${ws?.name || "Superfoods"} Team</p>`;

      try {
        const { sendTicketReply } = await import("@/lib/email");
        await sendTicketReply({
          workspaceId: workspace_id,
          toEmail: email,
          subject: "Your discount code inside",
          body,
          inReplyTo: null,
          agentName: ws?.name || "Superfoods",
          workspaceName: ws?.name || "Superfoods",
        });
        await admin.from("storefront_leads")
          .update({ fallback_emailed_at: new Date().toISOString() })
          .eq("workspace_id", workspace_id).eq("customer_id", customer_id);
        return { emailed: true };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });

    return result;
  },
);
