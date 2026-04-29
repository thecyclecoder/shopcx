/**
 * Marketing-shortcode autoresponder webhook.
 *
 * People sometimes reply to messages from our marketing shortcode (85041).
 * We don't actively monitor that number — but ignoring replies makes us
 * look broken. This endpoint:
 *
 *   1. Verifies the Twilio signature
 *   2. Logs the inbound reply (so the team can see what people are saying)
 *   3. Dedupes per-phone for 24h (one autoresponse per number per day —
 *      if a customer is in a back-and-forth loop we don't pile on)
 *   4. Returns TwiML with a transactional autoresponse pointing them
 *      to the help center
 *
 * STOP / HELP / UNSUBSCRIBE / START are reserved by carriers and Twilio
 * handles them directly — they never hit this endpoint.
 *
 * Twilio Console config: Phone Numbers → Short Codes → 85041
 *   "A message comes in" → POST https://shopcx.ai/api/webhooks/twilio/marketing-sms
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTwilioSignature } from "@/lib/twilio";

const AUTORESPONSE_TEXT =
  "This number isn't monitored. For help, please visit https://help.superfoodscompany.com — our team responds within a few hours.";

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

function twiml(message: string | null): NextResponse {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function POST(request: Request) {
  const text = await request.text();
  const params: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { params[k] = v; });

  const from = params.From || "";
  const to = params.To || "";
  const messageBody = params.Body || "";
  const messageSid = params.MessageSid || "";

  // Verify Twilio signature in production. The webhook URL must match
  // exactly what's configured in the Twilio console.
  const signature = request.headers.get("x-twilio-signature") || "";
  const webhookUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai"}/api/webhooks/twilio/marketing-sms`;
  if (process.env.NODE_ENV === "production" && !validateTwilioSignature(signature, webhookUrl, params)) {
    console.error("[marketing-sms] Invalid Twilio signature");
    return twiml(null);
  }

  if (!from || !to) return twiml(null);

  const admin = createAdminClient();

  // Log every inbound, regardless of whether we autorespond. Lets the team
  // audit what people are saying to the marketing shortcode.
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const { data: recent } = await admin
    .from("sms_marketing_inbound")
    .select("id, autoresponded")
    .eq("shortcode", to)
    .eq("from_phone", from)
    .gte("created_at", since)
    .eq("autoresponded", true)
    .limit(1)
    .maybeSingle();

  const shouldAutoRespond = !recent;

  await admin.from("sms_marketing_inbound").insert({
    shortcode: to,
    from_phone: from,
    body: messageBody,
    message_sid: messageSid,
    autoresponded: shouldAutoRespond,
  });

  return shouldAutoRespond ? twiml(AUTORESPONSE_TEXT) : twiml(null);
}
