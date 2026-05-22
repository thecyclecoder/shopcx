/**
 * Marketing-shortcode autoresponder webhook.
 *
 * People sometimes reply to messages from our marketing shortcode (85041).
 * We don't actively monitor that number — but ignoring replies makes us
 * look broken. This endpoint:
 *
 *   1. Verifies the Twilio signature
 *   2. Logs the inbound reply (so the team can see what people are saying)
 *   3. Detects STOP-style keywords and flips
 *      customers.sms_marketing_status='unsubscribed' (+ syncs to
 *      Shopify) so our internal record matches Twilio's carrier-level
 *      opt-out list. Twilio's Default Opt-Out also auto-replies and
 *      stops future sends, so this is defense-in-depth on our DB side.
 *   4. Dedupes autoresponses per-phone for 24h (one autoresponse per
 *      number per day — back-and-forth loops don't pile on). Skipped
 *      for STOP keywords (Twilio replies; we don't need to).
 *   5. Returns TwiML with a transactional autoresponse pointing them
 *      to the help center (for non-STOP inbounds)
 *
 * Twilio Console config: Phone Numbers → Short Codes → 85041
 *   "A message comes in" → POST https://shopcx.ai/api/webhooks/twilio/marketing-sms
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTwilioSignature } from "@/lib/twilio";
import { unsubscribeFromSmsMarketing, subscribeToSmsMarketing } from "@/lib/shopify-marketing";

const AUTORESPONSE_TEXT =
  "This number isn't monitored. For help, please visit https://help.superfoodscompany.com — our team responds within a few hours.";

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Keywords that should opt the customer out of SMS marketing. Mirrors
// Twilio's reserved list plus a few common variants ("please stop",
// "remove me") that Twilio's Default Opt-Out doesn't catch but
// customers commonly type. Case-insensitive, whole-message or
// first-word match (so a customer texting "thanks!" doesn't get
// unsubscribed for the word "ks" — we don't substring-match).
const STOP_KEYWORDS = new Set([
  "STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE",
  "OPTOUT", "OPT-OUT", "OPT OUT", "REMOVE",
]);

function isStopMessage(body: string): boolean {
  const trimmed = body.trim().toUpperCase();
  if (STOP_KEYWORDS.has(trimmed)) return true;
  // Common phrasings that Twilio doesn't auto-handle.
  if (/^(PLEASE\s+STOP|REMOVE\s+ME|STOP\s+MESSAGES|STOP\s+TEXTS|STOP\s+ALL)\b/i.test(body.trim())) {
    return true;
  }
  return false;
}

// Opt-in keywords. Twilio's Advanced Opt-Out auto-handles the carrier
// side (removing the number from the block list + replying with
// confirmation) — this set just flips our DB column back.
const START_KEYWORDS = new Set([
  "START", "UNSTOP", "YES", "SUBSCRIBE", "OPTIN", "OPT-IN", "OPT IN",
]);

function isStartMessage(body: string): boolean {
  const trimmed = body.trim().toUpperCase();
  if (START_KEYWORDS.has(trimmed)) return true;
  if (/^(RESUBSCRIBE|RE-?SUBSCRIBE\s+ME|RESUME)\b/i.test(body.trim())) return true;
  return false;
}

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

  // ── STOP / opt-out detection ─────────────────────────────────────
  // Trust Twilio's OptOutType parameter first (only present when
  // Advanced Opt-Out is enabled on the Messaging Service), then
  // fall back to a keyword match on the message body. Either way,
  // flip the customer's sms_marketing_status to 'unsubscribed' and
  // sync to Shopify so our DB matches Twilio's carrier-level block
  // list (Twilio will refuse outbound to this number with error
  // 21610 regardless — but our audience builds will keep
  // including the row until we flip the column).
  const optOutType = (params.OptOutType || "").toUpperCase();
  const isOptOut = optOutType === "STOP" || isStopMessage(messageBody);
  const isOptIn = optOutType === "START" || isStartMessage(messageBody);

  if (isOptOut || isOptIn) {
    // Resolve workspace by the shortcode the inbound came TO. The
    // shortcode field on workspaces (`twilio_phone_number`) stores
    // the bare digits (e.g. "85041"). Twilio sends `To` as the same
    // digits for short codes.
    const { data: ws } = await admin
      .from("workspaces")
      .select("id")
      .eq("twilio_phone_number", to.replace(/^\+/, ""))
      .maybeSingle();

    if (ws?.id) {
      // Look up every customer whose phone normalizes to the inbound
      // `From`. The RPC strips non-digits on both sides so rows
      // stored as +18583349198 / (858) 334-9198 / 858-334-9198 all
      // match. Returns rows regardless of current sms_marketing_status
      // so START can flip 'unsubscribed' rows back.
      const { data: matches, error: rpcErr } = await admin.rpc(
        "find_customers_by_phone",
        { p_workspace_id: ws.id, p_phone: from },
      );
      if (rpcErr) {
        console.error("[marketing-sms] phone lookup RPC failed:", rpcErr.message);
      }

      const newStatus = isOptOut ? "unsubscribed" : "subscribed";
      for (const cust of (matches || []) as Array<{ id: string; workspace_id: string; shopify_customer_id: string | null; sms_marketing_status: string | null }>) {
        // Idempotency: skip rows already in the target state. Cheaper
        // than always firing a Shopify mutation, and avoids needless
        // updated_at churn for the dashboard.
        if (cust.sms_marketing_status === newStatus) continue;
        if (cust.shopify_customer_id) {
          try {
            if (isOptOut) {
              await unsubscribeFromSmsMarketing(cust.workspace_id, cust.shopify_customer_id);
            } else {
              await subscribeToSmsMarketing(cust.workspace_id, cust.shopify_customer_id);
            }
          } catch (err) {
            console.error(`[marketing-sms] Shopify SMS ${isOptOut ? "unsubscribe" : "subscribe"} failed:`, cust.id, err);
          }
        }
        await admin.from("customers").update({
          sms_marketing_status: newStatus,
          updated_at: new Date().toISOString(),
        }).eq("id", cust.id);
      }
    }

    // Log the inbound + skip our autoresponder — Twilio's Advanced
    // Opt-Out already auto-replies with the carrier-mandated
    // confirmation for both STOP and START. Two replies look broken.
    await admin.from("sms_marketing_inbound").insert({
      shortcode: to,
      from_phone: from,
      body: messageBody,
      message_sid: messageSid,
      autoresponded: false,
    });
    return twiml(null);
  }

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
