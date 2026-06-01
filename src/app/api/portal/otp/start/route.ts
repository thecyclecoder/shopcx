/**
 * POST /api/portal/otp/start
 *
 * Portal login via OTP. Same Twilio Verify flow as checkout but
 * scoped to the workspace inferred from the request host (portal
 * is typically served on a custom subdomain like
 * portal.superfoodscompany.com).
 *
 * Body: { email, workspace_id?, channel?: "sms" | "email" }
 * (workspace_id optional — when omitted, we resolve from Referer/Host)
 *
 * Falls back to {eligible: false, suggest_magic_link: true} when no
 * profile match — caller can then offer the magic-link email path.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { startVerification } from "@/lib/twilio-verify";

interface PostBody {
  email?: string;
  workspace_id?: string;
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

async function resolveWorkspaceFromHost(admin: ReturnType<typeof createAdminClient>, request: NextRequest): Promise<string | null> {
  // Try Referer header (portal.superfoodscompany.com/login)
  const referer = request.headers.get("referer") || "";
  const hostMatch = referer.match(/https?:\/\/([^/]+)/);
  if (hostMatch) {
    const host = hostMatch[1];
    // help_slug subdomain pattern (superfoods.shopcx.ai)
    const slugMatch = host.match(/^([^.]+)\.shopcx\.ai$/);
    if (slugMatch) {
      const { data } = await admin.from("workspaces").select("id").eq("help_slug", slugMatch[1]).maybeSingle();
      if (data?.id) return data.id;
    }
    // Custom domain (portal.superfoodscompany.com etc.)
    const { data } = await admin
      .from("workspaces")
      .select("id")
      .or(`help_custom_domain.eq.${host},storefront_domain.eq.${host}`)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (!body.email) return NextResponse.json({ error: "missing_email" }, { status: 400 });
  const email = body.email.trim().toLowerCase();

  const admin = createAdminClient();
  const workspaceId = body.workspace_id || (await resolveWorkspaceFromHost(admin, request));
  if (!workspaceId) return NextResponse.json({ error: "workspace_unresolved" }, { status: 400 });

  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone")
    .eq("workspace_id", workspaceId)
    .ilike("email", email)
    .maybeSingle();
  if (!customer) {
    // Don't leak whether an email exists. Suggest the magic-link path
    // which is what the legacy login uses — that flow also no-ops
    // silently when the email doesn't match.
    return NextResponse.json({ eligible: false, suggest_magic_link: true });
  }

  const { data: ws } = await admin
    .from("workspaces")
    .select("twilio_verify_service_sid, name")
    .eq("id", workspaceId)
    .single();
  const serviceSid = ws?.twilio_verify_service_sid as string | null;
  if (!serviceSid) return NextResponse.json({ error: "verify_not_configured" }, { status: 500 });

  const profilePhone = (customer.phone as string | null) || null;
  const hasSms = !!profilePhone;
  let channel: "sms" | "email" = body.channel || (hasSms ? "sms" : "email");
  if (channel === "sms" && !hasSms) channel = "email";

  const destination = channel === "sms" ? profilePhone! : (customer.email as string);
  const maskedDestination = channel === "sms" ? maskPhone(destination) : maskEmail(destination);

  const verifyRes = await startVerification(serviceSid, destination, channel, ws?.name as string | undefined);
  if (!verifyRes.success) {
    return NextResponse.json({ error: "verify_send_failed", details: verifyRes.error }, { status: 502 });
  }

  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data: sessionRow, error: insertErr } = await admin
    .from("auth_otp_sessions")
    .insert({
      workspace_id: workspaceId,
      customer_id: customer.id,
      email,
      channel,
      phone_masked: channel === "sms" ? maskedDestination : null,
      twilio_verify_sid: verifyRes.verifySid || null,
      status: "pending",
      expires_at: expires,
    })
    .select("id")
    .single();
  if (insertErr || !sessionRow) {
    return NextResponse.json({ error: "session_insert_failed" }, { status: 500 });
  }

  return NextResponse.json({
    eligible: true,
    session_id: sessionRow.id,
    channel,
    masked_destination: maskedDestination,
    has_sms: hasSms,
  });
}
