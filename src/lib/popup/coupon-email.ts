/**
 * Shared "here's your popup discount code" email.
 *
 * Two fallback paths deliver the same email when SMS isn't the channel that
 * lands the code:
 *   - popup-coupon-fallback (abandonment): lead finished the EMAIL step but
 *     never completed the PHONE step → email the code 5 min later.
 *   - popup-sms-delivery-fallback (undelivered SMS): lead completed the phone
 *     step and we texted the code, but the SMS never reached `delivered`
 *     (stuck `queued`, carrier `undelivered`/`failed`) → email it as backup.
 *
 * Both stamp `storefront_leads.fallback_emailed_at` via this helper so a lead
 * never gets two fallback emails (the column is the single dedup guard shared
 * across both paths). Surfaced by ticket 8e9e325e (Harvey Kletz): his WELCOME
 * SMS sat at `queued` forever and `fallback_emailed_at` was null — he only got
 * the discount because the storefront also auto-applies it on-page.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";

export type PopupCouponEmailResult =
  | { emailed: true }
  | { skipped: string }
  | { error: string };

/**
 * Build + send the coupon-code email and stamp `fallback_emailed_at`.
 * Caller is responsible for the upstream eligibility checks (email consent,
 * SMS-not-delivered, etc.); this guards only against a double-send.
 */
export async function sendPopupCouponEmail(params: {
  workspaceId: string;
  customerId: string;
  email: string;
  couponCode: string;
  productHandle?: string | null;
}): Promise<PopupCouponEmailResult> {
  const { workspaceId, customerId, email, couponCode, productHandle } = params;
  const admin = createAdminClient();

  // Dedup: claim the slot first. Only proceed if fallback_emailed_at is still
  // null — a conditional update so two concurrent paths can't both send.
  const claimAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await admin
    .from("storefront_leads")
    .update({ fallback_emailed_at: claimAt })
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .is("fallback_emailed_at", null)
    .select("id");
  if (claimErr) return { error: claimErr.message };
  if (!claimed || claimed.length === 0) return { skipped: "already_sent" };

  const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();
  const { data: customer } = await admin.from("customers").select("first_name").eq("id", customerId).maybeSingle();
  const first = (customer?.first_name as string) || "there";

  // Cross-device redeem link — drops them back on the PDP with the code
  // auto-applied (and the price tables reflecting it), no typing required.
  let redeemUrl: string | null = null;
  if (productHandle) {
    try {
      const { buildPopupRedeemUrl } = await import("@/lib/popup/redeem-link");
      redeemUrl = await buildPopupRedeemUrl(workspaceId, customerId, couponCode, productHandle);
    } catch (e) {
      console.warn("[popup-coupon-email] redeem link build failed:", e instanceof Error ? e.message : e);
    }
  }

  const cta = redeemUrl
    ? `<p><a href="${redeemUrl}" style="display:inline-block;background:#1f5e3a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;">Shop with my discount applied →</a></p>
<p style="font-size:12px;color:#888;">The discount is already applied — just complete checkout. This code is reserved for you and won't work for anyone else, so please don't share it.</p>`
    : `<p>Enter it at checkout to claim your savings — it's reserved just for you and won't work for anyone else, so please don't share it.</p>`;

  const body = `<p>Hi ${first}, here's the discount code you unlocked:</p>
<p style="font-size:22px;font-weight:700;letter-spacing:1px;">${couponCode}</p>
${cta}
<p>The ${ws?.name || "Superfoods"} Team</p>`;

  try {
    const { sendTicketReply } = await import("@/lib/email");
    await sendTicketReply({
      workspaceId,
      toEmail: email,
      subject: "Your discount code inside",
      body,
      inReplyTo: null,
      agentName: ws?.name || "Superfoods",
      workspaceName: ws?.name || "Superfoods",
    });
    return { emailed: true };
  } catch (e) {
    // Send failed — release the claim so a later retry / the other path can
    // try again (don't leave a phantom fallback_emailed_at with no email out).
    await admin.from("storefront_leads")
      .update({ fallback_emailed_at: null })
      .eq("workspace_id", workspaceId).eq("customer_id", customerId).eq("fallback_emailed_at", claimAt)
      .then(() => undefined, () => undefined);
    return { error: errText(e) };
  }
}
