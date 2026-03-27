import { createAdminClient } from "@/lib/supabase/admin";
import crypto from "crypto";

/**
 * Get the workspace's assigned Twilio phone number.
 * Twilio account credentials come from global env vars.
 */
export async function getWorkspacePhone(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("twilio_phone_number")
    .eq("id", workspaceId)
    .single();

  return workspace?.twilio_phone_number || null;
}

/**
 * Send an SMS using the global Twilio account and the workspace's assigned phone number.
 */
export async function sendSMS(
  workspaceId: string,
  to: string,
  body: string
): Promise<{ success: boolean; messageSid?: string; error?: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return { success: false, error: "Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)" };
  }

  const fromNumber = await getWorkspacePhone(workspaceId);
  if (!fromNumber) {
    return { success: false, error: "No Twilio phone number assigned to this workspace" };
  }

  // Truncate to SMS-safe length (320 chars max for 2 segments)
  const truncatedBody = body.length > 320 ? body.slice(0, 317) + "..." : body;

  try {
    const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: to,
          From: fromNumber,
          Body: truncatedBody,
        }).toString(),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.message || `Twilio API error: ${res.status}` };
    }

    const data = await res.json();
    return { success: true, messageSid: data.sid };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Validate Twilio webhook signature.
 * Uses the global TWILIO_AUTH_TOKEN env var.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;

  try {
    // Build the data string: URL + sorted params key+value
    const sortedKeys = Object.keys(params).sort();
    let dataStr = url;
    for (const key of sortedKeys) {
      dataStr += key + params[key];
    }

    const computed = crypto
      .createHmac("sha1", authToken)
      .update(dataStr, "utf8")
      .digest("base64");

    return computed === signature;
  } catch {
    return false;
  }
}
