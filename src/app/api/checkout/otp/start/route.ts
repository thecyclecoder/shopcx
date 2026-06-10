/**
 * POST /api/checkout/otp/start
 *
 * Body: { cart_token, email, channel?: "sms" | "email" }
 *
 * Behavior:
 *   1. Resolve the customer by email within the cart's workspace.
 *   2. Gate: only returning customers (≥1 prior order OR active sub)
 *      get the OTP path. New emails get { eligible: false } so the
 *      checkout client doesn't show the "Welcome back" CTA.
 *   3. Pick the channel:
 *        explicit `channel` from body wins
 *        else SMS if the profile has a phone on file
 *        else email
 *   4. Phone-spoofing guard: SMS goes ONLY to the phone stored on
 *      the matched profile — NEVER the phone typed into checkout.
 *   5. Call Twilio Verify (verifications.create).
 *   6. Insert auth_otp_sessions row, return { session_id, channel,
 *      masked_destination }.
 *
 * Returns:
 *   { eligible: true, session_id, channel, masked_destination, has_sms, has_email }
 *   { eligible: false }
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { startVerification } from "@/lib/twilio-verify";
import { toE164US } from "@/lib/shopify-customer-update";

interface PostBody {
  cart_token?: string;
  email?: string;
  channel?: "sms" | "email";
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const visibleLocal = local.length <= 2 ? local : `${local.slice(0, 2)}•••`;
  return `${visibleLocal}@${domain}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits ? `•••${digits.slice(-2)}` : "•••";
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (!body.cart_token || !body.email) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();
  const admin = createAdminClient();

  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id")
    .eq("token", body.cart_token)
    .maybeSingle();
  if (!cart) return NextResponse.json({ error: "cart_not_found" }, { status: 404 });

  // Match a customer by email within this workspace
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone, subscription_status")
    .eq("workspace_id", cart.workspace_id)
    .ilike("email", email)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ eligible: false, reason: "no_match" });
  }

  // Gate: only "returning" customers — those with an order in their
  // history OR a subscription. A bare lead with no orders doesn't
  // need to log in; pushing them through OTP just adds friction.
  const { count: orderCount } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", cart.workspace_id)
    .eq("customer_id", customer.id);
  const hasSub = ["active", "paused", "cancelled"].includes((customer.subscription_status as string) || "");
  const returning = (orderCount || 0) > 0 || hasSub;
  if (!returning) {
    return NextResponse.json({ eligible: false, reason: "not_returning" });
  }

  // Resolve Verify Service SID
  const { data: ws } = await admin
    .from("workspaces")
    .select("twilio_verify_service_sid, name")
    .eq("id", cart.workspace_id)
    .single();
  const serviceSid = ws?.twilio_verify_service_sid as string | null;
  if (!serviceSid) {
    return NextResponse.json({ error: "verify_not_configured" }, { status: 500 });
  }

  // Decide channel. The phone we send to is the one ON FILE for the
  // matched profile, NEVER the one typed into checkout — anti-spoof.
  // Normalize to E.164: many stored numbers are display-formatted
  // ("(858) 334-9198"), which Twilio Verify rejects outright — that
  // silently 502'd the whole OTP path and no modal ever showed.
  const profilePhone = customer.phone ? toE164US(customer.phone as string) : null;
  const hasSms = !!profilePhone;
  const hasEmail = !!customer.email;
  let channel: "sms" | "email" = body.channel || (hasSms ? "sms" : "email");
  if (channel === "sms" && !hasSms) channel = "email";

  const destination = channel === "sms" ? profilePhone! : (customer.email as string);
  const maskedDestination = channel === "sms" ? maskPhone(destination) : maskEmail(destination);

  const verifyRes = await startVerification(serviceSid, destination, channel);
  if (!verifyRes.success) {
    return NextResponse.json({ error: "verify_send_failed", details: verifyRes.error }, { status: 502 });
  }

  // Persist the session row
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data: session, error: insertErr } = await admin
    .from("auth_otp_sessions")
    .insert({
      workspace_id: cart.workspace_id,
      customer_id: customer.id,
      email,
      channel,
      phone_masked: channel === "sms" ? maskedDestination : null,
      twilio_verify_sid: verifyRes.verifySid || null,
      status: "pending",
      expires_at: expires,
      cart_token: body.cart_token,
    })
    .select("id")
    .single();
  if (insertErr || !session) {
    return NextResponse.json({ error: "session_insert_failed" }, { status: 500 });
  }

  return NextResponse.json({
    eligible: true,
    session_id: session.id,
    channel,
    masked_destination: maskedDestination,
    has_sms: hasSms,
    has_email: hasEmail,
  });
}
