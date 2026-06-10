/**
 * POST /api/checkout/otp/resend
 *
 * Body: { session_id, channel?: "sms" | "email" }
 *
 * Resends the OTP. `channel` lets the UI offer "try another way":
 *   - omitted → resend on the existing session's channel
 *   - "sms"   → switch to SMS (requires profile to have a phone)
 *   - "email" → switch to email
 *
 * Rate limit: 60 seconds between sends per session. Returns 429 with
 * `retry_after_seconds` so the client can show a countdown.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { startVerification } from "@/lib/twilio-verify";
import { toE164US } from "@/lib/shopify-customer-update";

interface PostBody {
  session_id?: string;
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
  if (!body.session_id) return NextResponse.json({ error: "missing_session_id" }, { status: 400 });

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

  // Rate limit: 60s between sends on the same session
  const lastSentAt = new Date(session.updated_at as string).getTime();
  const since = Math.floor((Date.now() - lastSentAt) / 1000);
  if (since < 60) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: 60 - since },
      { status: 429 },
    );
  }

  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone")
    .eq("id", session.customer_id)
    .single();
  if (!customer) return NextResponse.json({ error: "customer_missing" }, { status: 500 });

  const { data: ws } = await admin
    .from("workspaces")
    .select("twilio_verify_service_sid, name")
    .eq("id", session.workspace_id)
    .single();
  const serviceSid = ws?.twilio_verify_service_sid as string | null;
  if (!serviceSid) return NextResponse.json({ error: "verify_not_configured" }, { status: 500 });

  // Channel resolution — explicit body wins; else stick with existing.
  // Normalize to E.164 (stored numbers are often display-formatted, which
  // Twilio Verify rejects).
  const profilePhone = customer.phone ? toE164US(customer.phone as string) : null;
  const requestedChannel: "sms" | "email" = body.channel || (session.channel as "sms" | "email");
  let channel: "sms" | "email" = requestedChannel;
  if (channel === "sms" && !profilePhone) channel = "email";

  const destination = channel === "sms" ? profilePhone! : (customer.email as string);
  const maskedDestination = channel === "sms" ? maskPhone(destination) : maskEmail(destination);

  const verifyRes = await startVerification(serviceSid, destination, channel, ws?.name as string | undefined);
  if (!verifyRes.success) {
    return NextResponse.json({ error: "verify_send_failed", details: verifyRes.error }, { status: 502 });
  }

  await admin
    .from("auth_otp_sessions")
    .update({
      channel,
      phone_masked: channel === "sms" ? maskedDestination : null,
      twilio_verify_sid: verifyRes.verifySid || null,
      status: "pending",
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  return NextResponse.json({
    ok: true,
    session_id: session.id,
    channel,
    masked_destination: maskedDestination,
  });
}
