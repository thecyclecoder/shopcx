/**
 * POST /api/popup/claim  (storefront-mvp Phase 4e — phone step)
 *
 * The phone step of the smart-popup form. Validates the number with Twilio
 * Lookup (must be an SMS-capable MOBILE — no fake numbers get the discount,
 * keeps the SMS list clean), then delivers the already-minted coupon by SMS
 * and auto-applies it to the session (a valid mobile is on the order AND
 * texted to them, so auto-apply is earned). The confirmation screen NEVER
 * shows the code — it's revealed only here, via SMS.
 *
 * Returns { ok, mobile } — never the coupon code.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { lookupPhone } from "@/lib/twilio-lookup";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    workspace_id?: string;
    customer_id?: string;
    phone?: string;
    anonymous_id?: string | null;
    sms_consent?: boolean;
    product_handle?: string | null;
  };
  if (!body.workspace_id || !body.customer_id || !body.phone) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  // Gate: real SMS-capable mobile only. Fails closed on any Lookup error.
  const lookup = await lookupPhone(body.phone);
  if (!lookup.mobile) {
    return NextResponse.json({ ok: false, mobile: false, reason: lookup.reason || "not_mobile" }, { status: 200 });
  }
  const e164 = lookup.e164 || body.phone;
  const admin = createAdminClient();

  // Read the coupon minted at the email step.
  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name")
    .eq("id", body.customer_id)
    .maybeSingle();
  const { data: lead } = await admin
    .from("storefront_leads")
    .select("coupon_code_issued")
    .eq("workspace_id", body.workspace_id)
    .eq("customer_id", body.customer_id)
    .maybeSingle();
  const couponCode = (lead?.coupon_code_issued as string) || null;
  if (!couponCode) {
    return NextResponse.json({ ok: false, mobile: true, reason: "no_coupon" }, { status: 200 });
  }

  // Persist the verified phone + SMS consent on the customer + lead.
  const nowIso = new Date().toISOString();
  await admin.from("customers").update({
    phone: e164,
    sms_marketing_status: body.sms_consent === false ? "not_subscribed" : "subscribed",
    updated_at: nowIso,
  }).eq("id", body.customer_id);
  await admin.from("storefront_leads").update({
    phone: e164,
    sms_consent_at: body.sms_consent === false ? null : nowIso,
    updated_at: nowIso,
  }).eq("workspace_id", body.workspace_id).eq("customer_id", body.customer_id);

  // Cross-device redeem link — drops them back on the PDP with the code
  // auto-applied (works even if they open the text on another device).
  // Shortened (sprfd.co/…) so the SMS stays under one 160-char segment.
  let redeemUrl: string | null = null;
  if (body.product_handle) {
    try {
      const { buildPopupRedeemShortUrl } = await import("@/lib/popup/redeem-link");
      redeemUrl = await buildPopupRedeemShortUrl(body.workspace_id, body.customer_id, couponCode, body.product_handle);
    } catch (e) {
      console.warn("[popup/claim] redeem link build failed:", e instanceof Error ? e.message : e);
    }
  }

  // Deliver the code by SMS. The disclaimer matters: the code binds to this
  // customer, so a shared link won't work for anyone else.
  try {
    const { sendSMS } = await import("@/lib/twilio");
    const first = (customer?.first_name as string) || "there";
    const msg = redeemUrl
      ? `Hi ${first}! Your code ${couponCode} is auto-applied here: ${redeemUrl} — it's just for you and won't work for anyone else.`
      : `Hi ${first}! Here's your exclusive discount code: ${couponCode}. It's already applied to your order — just complete checkout to claim it. Just for you — don't share.`;
    await sendSMS(body.workspace_id, e164, msg);
  } catch (e) {
    console.warn("[popup/claim] SMS send failed:", e instanceof Error ? e.message : e);
  }

  // Mark the popup as converted (lead captured + phone verified).
  if (body.anonymous_id) {
    await admin.from("popup_decisions").update({ engaged: true, converted: true, coupon_code: couponCode, updated_at: nowIso })
      .eq("workspace_id", body.workspace_id).eq("anonymous_id", body.anonymous_id)
      .then(() => undefined, () => undefined);
  }

  // Auto-apply: stamp the code on the visitor's open cart_draft (if any),
  // and set a cookie the checkout reads to pre-apply when the cart is
  // created later. The code is never rendered — the cookie isn't shown.
  if (body.anonymous_id) {
    await admin.from("cart_drafts").update({ discount_code: couponCode, updated_at: nowIso })
      .eq("workspace_id", body.workspace_id).eq("anonymous_id", body.anonymous_id).eq("status", "open")
      .then(() => undefined, () => undefined);
  }

  const res = NextResponse.json({ ok: true, mobile: true });
  res.cookies.set("popup_coupon", couponCode, {
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    sameSite: "lax",
    httpOnly: false, // checkout client reads it to pre-apply
  });
  // Bind the coupon's owner so derived codes resolve for them (cart + checkout
  // read sx_customer; httpOnly — server only).
  res.cookies.set("sx_customer", body.customer_id, {
    path: "/",
    maxAge: 60 * 60 * 24 * 60,
    sameSite: "lax",
    httpOnly: true,
    secure: true,
  });
  return res;
}
