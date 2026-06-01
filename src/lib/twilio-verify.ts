/**
 * Twilio Verify wrapper. Verify is Twilio's purpose-built OTP service —
 * we don't manage codes, expiry, brute-force protection, or
 * deliverability routing. We just call:
 *
 *   verifications.create({ to, channel })   → Twilio sends the OTP
 *   verificationChecks.create({ to, code }) → Twilio verifies it
 *
 * Verify uses Twilio's high-deliverability OTP pool, which carriers
 * explicitly whitelist for transactional traffic. No 10DLC compliance
 * burden for our 888 toll-free number on the OTP path.
 *
 * Per-workspace Service SID lives in workspaces.twilio_verify_service_sid.
 * Provisioned once via the Settings → Integrations → Twilio "Setup OTP"
 * action which calls `createVerifyService` below.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const TWILIO_VERIFY_HOST = "https://verify.twilio.com";

function getCreds(): { accountSid: string; authToken: string } | { error: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return { error: "Twilio credentials not configured" };
  }
  return { accountSid, authToken };
}

function authHeader(accountSid: string, authToken: string): string {
  return "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");
}

/**
 * Provision a Verify Service for a workspace and store the SID on
 * the workspace row. Idempotent: if the workspace already has a
 * SID, returns it without creating a new service.
 */
export async function createVerifyService(
  workspaceId: string,
  friendlyName: string,
): Promise<{ success: boolean; sid?: string; error?: string }> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("twilio_verify_service_sid")
    .eq("id", workspaceId)
    .single();
  if (ws?.twilio_verify_service_sid) {
    return { success: true, sid: ws.twilio_verify_service_sid as string };
  }

  const creds = getCreds();
  if ("error" in creds) return { success: false, error: creds.error };

  // Sanitize: Twilio rejects FriendlyName values longer than ~30
  // chars or containing special chars (the docs are vague here).
  // Strip non-alphanumeric/space, trim, cap at 30.
  const safeName = (friendlyName || "ShopCX OTP")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);
  const params = new URLSearchParams({
    FriendlyName: safeName,
    CodeLength: "6",
    // Verification codes valid for 10 minutes (Twilio default is 10).
    // Keep default — overriding requires special pricing.
  });
  const res = await fetch(`${TWILIO_VERIFY_HOST}/v2/Services`, {
    method: "POST",
    headers: {
      Authorization: authHeader(creds.accountSid, creds.authToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null) as { sid?: string; message?: string; code?: number } | null;
  if (!res.ok || !data?.sid) {
    return { success: false, error: data?.message || `Twilio Verify error: ${res.status}` };
  }

  await admin
    .from("workspaces")
    .update({ twilio_verify_service_sid: data.sid })
    .eq("id", workspaceId);

  return { success: true, sid: data.sid };
}

/**
 * Start a verification — Twilio sends the code via the given channel.
 * `to` is the destination (E.164 phone for SMS, email for email).
 */
export async function startVerification(
  serviceSid: string,
  to: string,
  channel: "sms" | "email",
  customFriendlyName?: string,
): Promise<{ success: boolean; verifySid?: string; status?: string; error?: string; errorCode?: number }> {
  const creds = getCreds();
  if ("error" in creds) return { success: false, error: creds.error };

  const params = new URLSearchParams({
    To: to,
    Channel: channel,
  });
  if (customFriendlyName) {
    // Verify lets us override the sender name shown in the message
    // ("Your verification code from <name>") on a per-call basis.
    params.append("CustomFriendlyName", customFriendlyName);
  }

  const res = await fetch(`${TWILIO_VERIFY_HOST}/v2/Services/${serviceSid}/Verifications`, {
    method: "POST",
    headers: {
      Authorization: authHeader(creds.accountSid, creds.authToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null) as { sid?: string; status?: string; message?: string; code?: number } | null;
  if (!res.ok || !data?.sid) {
    return {
      success: false,
      error: data?.message || `Twilio Verify error: ${res.status}`,
      errorCode: typeof data?.code === "number" ? data.code : undefined,
    };
  }
  return { success: true, verifySid: data.sid, status: data.status };
}

/**
 * Submit the customer-entered code for verification. Returns
 * `approved: true` on success.
 */
export async function checkVerification(
  serviceSid: string,
  to: string,
  code: string,
): Promise<{ success: boolean; approved: boolean; status?: string; error?: string; errorCode?: number }> {
  const creds = getCreds();
  if ("error" in creds) return { success: false, approved: false, error: creds.error };

  const params = new URLSearchParams({
    To: to,
    Code: code,
  });
  const res = await fetch(`${TWILIO_VERIFY_HOST}/v2/Services/${serviceSid}/VerificationCheck`, {
    method: "POST",
    headers: {
      Authorization: authHeader(creds.accountSid, creds.authToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null) as { status?: string; valid?: boolean; message?: string; code?: number } | null;
  if (!res.ok) {
    // 404 = no pending verification (expired / used). Surface as
    // not-approved rather than a hard error so the UI can offer a
    // resend.
    return {
      success: false,
      approved: false,
      status: data?.status,
      error: data?.message || `Twilio Verify error: ${res.status}`,
      errorCode: typeof data?.code === "number" ? data.code : undefined,
    };
  }
  return { success: true, approved: data?.status === "approved", status: data?.status };
}
