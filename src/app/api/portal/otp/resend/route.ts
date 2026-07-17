/**
 * POST /api/portal/otp/resend
 * Body: { session_id, channel?: "sms" | "email" }
 * Same shape as /api/checkout/otp/resend — re-fires the verification
 * with optional channel switch ("text me instead" / "email me").
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { startVerificationWithFallback } from "@/lib/twilio-verify";
import { toE164US } from "@/lib/phone";

interface PostBody {
  session_id?: string;
  channel?: "sms" | "email";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!body.session_id) return NextResponse.json({ error: "missing_session_id" }, { status: 400 });
  if (!UUID_RE.test(body.session_id)) return NextResponse.json({ error: "invalid_session" }, { status: 400 });

  const admin = createAdminClient();
  const { data: session } = await admin
    .from("auth_otp_sessions")
    .select("*")
    .eq("id", body.session_id)
    .maybeSingle();
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  if (session.status === "verified") return NextResponse.json({ error: "already_verified" }, { status: 400 });

  const since = Math.floor((Date.now() - new Date(session.updated_at as string).getTime()) / 1000);
  if (since < 60) {
    return NextResponse.json({ error: "rate_limited", retry_after_seconds: 60 - since }, { status: 429 });
  }

  const { data: customer } = await admin.from("customers").select("email, phone").eq("id", session.customer_id).single();
  if (!customer) return NextResponse.json({ error: "customer_missing" }, { status: 500 });

  const { data: ws } = await admin.from("workspaces").select("twilio_verify_service_sid, name").eq("id", session.workspace_id).single();
  const serviceSid = ws?.twilio_verify_service_sid as string | null;
  if (!serviceSid) return NextResponse.json({ error: "verify_not_configured" }, { status: 500 });

  const profilePhone = customer.phone ? toE164US(customer.phone as string) : null;
  const requested: "sms" | "email" = body.channel || (session.channel as "sms" | "email");

  const verifyRes = await startVerificationWithFallback(serviceSid, {
    phoneE164: profilePhone,
    email: (customer.email as string) || null,
    requested,
  });
  if (!verifyRes.success) {
    // A failed OTP send (after the SMS→email fallback) is an expected
    // per-request outcome, not a server fault — the customer can still
    // switch to the magic-link escape hatch. Return a structured 422 so
    // the login surfaces the failure (res.ok === false) without tripping
    // the >=500 Vercel-errors alert that pages the owner
    // (src/app/api/webhooks/vercel-logs/route.ts).
    return NextResponse.json({ error: "verify_send_failed", details: verifyRes.error }, { status: 422 });
  }
  const channel = verifyRes.channel;
  const maskedDestination = channel === "sms" ? maskPhone(verifyRes.destination) : maskEmail(verifyRes.destination);

  await admin.from("auth_otp_sessions").update({
    channel, phone_masked: channel === "sms" ? maskedDestination : null,
    twilio_verify_sid: verifyRes.verifySid || null, status: "pending",
    updated_at: new Date().toISOString(),
  }).eq("id", session.id);

  return NextResponse.json({ ok: true, channel, masked_destination: maskedDestination, fell_back: verifyRes.fellBack });
}
