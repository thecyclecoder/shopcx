/**
 * POST /api/portal/otp/verify
 *
 * Body: { session_id, code }
 * On success: set portal_customer_id + portal_workspace_id cookies
 * (the existing portal session shape) AND sx_session for storefront
 * continuity. Returns { ok: true } so the client can redirect to /.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkVerification } from "@/lib/twilio-verify";
import { setSessionCookie } from "@/lib/auth-session";
import { toE164US } from "@/lib/phone";

interface PostBody {
  session_id?: string;
  code?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (!body.session_id || !body.code) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!UUID_RE.test(body.session_id)) {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
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
  if (session.status === "verified") return NextResponse.json({ error: "already_verified" }, { status: 400 });
  if (new Date(session.expires_at as string).getTime() < Date.now()) {
    await admin.from("auth_otp_sessions").update({ status: "expired" }).eq("id", session.id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if ((session.attempts as number) >= 5) {
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  }

  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone")
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

  // Must hit the same E.164 destination that start/resend sent to, or
  // Twilio's verification_check won't match the pending verification.
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

  await admin
    .from("auth_otp_sessions")
    .update({ status: "verified", verified_at: new Date().toISOString() })
    .eq("id", session.id);

  const response = NextResponse.json({ ok: true });
  // Set both the legacy portal cookies (used by portal pages) AND
  // the storefront sx_session cookie (used by checkout autofill).
  setSessionCookie(response, session.workspace_id, customer.id);
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  };
  response.cookies.set("portal_customer_id", customer.id, opts);
  response.cookies.set("portal_workspace_id", session.workspace_id, opts);
  return response;
}
