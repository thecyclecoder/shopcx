/**
 * POST /api/checkout/otp/verify
 *
 * Body: { session_id, code }
 *
 * On approve:
 *   • Mark the session row verified
 *   • Set the signed `sx_session` cookie (HS256, 7d)
 *   • Return a customer-snapshot payload the checkout client uses to
 *     autofill (first/last name, last shipping address, masked saved
 *     payment methods)
 *
 * On reject:
 *   • Increment attempts
 *   • Lock the session after 5 wrong attempts (Twilio Verify ALSO
 *     locks server-side at 5; we mirror so the client UX is clean)
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkVerification } from "@/lib/twilio-verify";
import { toE164US } from "@/lib/shopify-customer-update";
import { setSessionCookie } from "@/lib/auth-session";

interface PostBody {
  session_id?: string;
  code?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (!body.session_id || !body.code) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const code = body.code.trim();
  if (!/^\d{4,8}$/.test(code)) {
    return NextResponse.json({ error: "invalid_code_format" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: session } = await admin
    .from("auth_otp_sessions")
    .select("*")
    .eq("id", body.session_id)
    .maybeSingle();
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  if (session.status === "verified") {
    return NextResponse.json({ error: "already_verified" }, { status: 400 });
  }
  if (session.status === "expired" || new Date(session.expires_at as string).getTime() < Date.now()) {
    await admin.from("auth_otp_sessions").update({ status: "expired" }).eq("id", session.id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if ((session.attempts as number) >= 5) {
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  }

  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone, first_name, last_name")
    .eq("id", session.customer_id)
    .single();
  if (!customer) return NextResponse.json({ error: "customer_missing" }, { status: 500 });

  const { data: ws } = await admin
    .from("workspaces")
    .select("twilio_verify_service_sid")
    .eq("id", session.workspace_id)
    .single();
  const serviceSid = ws?.twilio_verify_service_sid as string | null;
  if (!serviceSid) return NextResponse.json({ error: "verify_not_configured" }, { status: 500 });

  // Must match the E.164 `To` the verification was CREATED with in otp/start.
  const destination = session.channel === "sms"
    ? (toE164US(customer.phone as string) || (customer.phone as string))
    : (customer.email as string);
  const check = await checkVerification(serviceSid, destination, code);

  if (!check.approved) {
    await admin
      .from("auth_otp_sessions")
      .update({ attempts: (session.attempts as number) + 1, updated_at: new Date().toISOString() })
      .eq("id", session.id);
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }

  // Snapshot the profile for autofill. Last shipping address comes
  // from the most recent order (orders.shipping_address JSONB).
  const { data: lastOrder } = await admin
    .from("orders")
    .select("shipping_address, billing_address")
    .eq("workspace_id", session.workspace_id)
    .eq("customer_id", customer.id)
    .not("shipping_address", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Mark session verified
  await admin
    .from("auth_otp_sessions")
    .update({ status: "verified", verified_at: new Date().toISOString() })
    .eq("id", session.id);

  // Backfill the cart with the customer_id so subsequent checkout
  // calls see the link.
  if (session.cart_token) {
    await admin
      .from("cart_drafts")
      .update({ customer_id: customer.id, email: customer.email, phone: customer.phone })
      .eq("token", session.cart_token);
  }

  const response = NextResponse.json({
    ok: true,
    customer: {
      id: customer.id,
      email: customer.email,
      phone: customer.phone,
      first_name: customer.first_name,
      last_name: customer.last_name,
    },
    last_shipping_address: lastOrder?.shipping_address || null,
    last_billing_address: lastOrder?.billing_address || null,
  });
  setSessionCookie(response, session.workspace_id, customer.id);
  // Also set the legacy portal cookies so an OTP'd customer can go
  // straight to the portal (subscriptions, orders, account) without
  // re-authenticating via magic link.
  const portalCookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  };
  response.cookies.set("portal_customer_id", customer.id, portalCookieOpts);
  response.cookies.set("portal_workspace_id", session.workspace_id, portalCookieOpts);
  return response;
}
