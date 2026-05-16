/**
 * Twilio status callback for marketing SMS sends.
 *
 * Configured in Twilio: Messaging Service → Integration →
 *   "Delivery status callback URL" → POST
 *   https://shopcx.ai/api/webhooks/twilio/marketing-status
 *
 * Twilio calls this for every status transition: queued → sending →
 * sent → delivered, OR queued → sending → sent → undelivered /
 * failed. The MessageSid matches what we stored on
 * sms_campaign_recipients.message_sid when we placed the original
 * POST to the Twilio API.
 *
 * We do two things:
 *   1. Update sms_campaign_recipients status + delivered_at /
 *      error / error_code so the campaign detail UI shows real
 *      outcomes.
 *   2. On fatal carrier errors (30003 unreachable, 30004 blocked,
 *      30005 unknown destination), stamp customers.phone_status so
 *      future campaigns skip the customer — same logic as the
 *      send-tick failure path, but driven by post-send carrier
 *      response.
 *
 * STOP / HELP / opt-out events: Twilio surfaces these as 21610
 * errors on subsequent sends, not as a status callback on the
 * original send. They're caught in the send-tick fatal-code path.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTwilioSignature } from "@/lib/twilio";

// Mirror of classifyTwilioError in marketing-text.ts — kept inline so
// the two callers (send-tick + status-callback) can diverge if
// carrier-specific codes need different handling later.
function classifyTwilioError(code: number | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 21211:
    case 21217:
    case 21407:
    case 21421:
    case 21614:
    case 21660:
      return "invalid";
    case 21408:
    case 21612:
      return "carrier_violation";
    case 21610:
      return "unsubscribed";
    case 30003:
    case 30004:
    case 30005:
    case 30006:
    case 30007:
    case 30008:
      return "blocked";
    default:
      return null;
  }
}

export async function POST(request: Request) {
  const body = await request.text();

  // Verify the Twilio signature — same approach as the inbound
  // handler. If TWILIO_AUTH_TOKEN isn't configured we accept the
  // request (dev mode); in prod the env var is always set.
  const signature = request.headers.get("x-twilio-signature");
  const url = request.url;
  const params: Record<string, string> = {};
  new URLSearchParams(body).forEach((v, k) => { params[k] = v; });

  if (process.env.TWILIO_AUTH_TOKEN && signature) {
    const valid = validateTwilioSignature(signature, url, params);
    if (!valid) {
      // 200 keeps Twilio from retrying — silent drop on bad signature
      return new NextResponse("", { status: 200 });
    }
  }

  const messageSid = params.MessageSid;
  const status = params.MessageStatus; // queued | sending | sent | delivered | undelivered | failed
  const errorCodeStr = params.ErrorCode;
  const errorCode = errorCodeStr ? parseInt(errorCodeStr, 10) : undefined;
  const errorMessage = params.ErrorMessage;

  if (!messageSid || !status) {
    return new NextResponse("", { status: 200 });
  }

  const admin = createAdminClient();

  // Find the recipient by message_sid. message_sid is unique per
  // outbound message, so this is a single-row lookup.
  const { data: recipient } = await admin
    .from("sms_campaign_recipients")
    .select("id, customer_id, campaign_id, workspace_id, status")
    .eq("message_sid", messageSid)
    .maybeSingle();

  if (!recipient) {
    // Status callback for a message we don't have a recipient row
    // for — probably from a different system (ticket reply, dunning,
    // etc). Silent skip.
    return new NextResponse("", { status: 200 });
  }

  const now = new Date().toISOString();
  switch (status) {
    case "delivered": {
      // Only advance from 'sent' → 'delivered'. Don't overwrite a
      // recipient that's already been marked failed_permanent by a
      // later status (shouldn't happen, but defensive).
      await admin
        .from("sms_campaign_recipients")
        .update({
          status: "delivered",
          delivered_at: now,
          updated_at: now,
        })
        .eq("id", recipient.id)
        .in("status", ["sent", "delivered"]);
      break;
    }
    case "undelivered":
    case "failed": {
      const phoneStatus = classifyTwilioError(errorCode);
      const isFatal = phoneStatus !== null;
      await admin
        .from("sms_campaign_recipients")
        .update({
          status: isFatal ? "failed_permanent" : "failed",
          error: errorCode ? `${errorCode}: ${errorMessage || "carrier failure"}` : errorMessage || "undelivered",
          updated_at: now,
        })
        .eq("id", recipient.id);
      if (isFatal && recipient.customer_id) {
        await admin
          .from("customers")
          .update({
            phone_status: phoneStatus,
            phone_status_code: errorCode,
            phone_status_at: now,
          })
          .eq("id", recipient.customer_id);
      }
      break;
    }
    // queued / sending / sent — already captured at send time, no-op.
    default:
      break;
  }

  return new NextResponse("", { status: 200 });
}
