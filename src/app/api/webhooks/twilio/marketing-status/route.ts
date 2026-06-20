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
  const now = new Date().toISOString();

  // Find the recipient by message_sid. message_sid is unique per
  // outbound message, so this is a single-row lookup.
  const { data: recipient } = await admin
    .from("sms_campaign_recipients")
    .select("id, customer_id, campaign_id, workspace_id, status")
    .eq("message_sid", messageSid)
    .maybeSingle();

  if (!recipient) {
    // Not a marketing-campaign send. The popup-coupon SMS sends direct from the
    // short code with this route passed as a per-message StatusCallback (see
    // src/app/api/popup/claim/route.ts), so its status callbacks land here too —
    // match the lead by message sid and record delivery there.
    const { data: lead } = await admin
      .from("storefront_leads")
      .select("id")
      .eq("sms_message_sid", messageSid)
      .maybeSingle();
    if (lead) {
      await admin
        .from("storefront_leads")
        .update({ sms_status: status, sms_status_at: now, updated_at: now })
        .eq("id", lead.id);
    }
    // Otherwise it's from another system (ticket reply, dunning, etc). Skip.
    return new NextResponse("", { status: 200 });
  }

  switch (status) {
    case "sent": {
      // Twilio handed the message off to the carrier. With SendAt
      // scheduling the row is currently 'scheduled' (or 'sent' if
      // we sent immediately and missed the prior callback). Either
      // way, advance to 'sent' and stamp sent_at. Don't overwrite
      // failed/failed_permanent (defensive).
      await admin
        .from("sms_campaign_recipients")
        .update({
          status: "sent",
          sent_at: now,
          updated_at: now,
        })
        .eq("id", recipient.id)
        .in("status", ["scheduled", "sending", "sent"]);
      break;
    }
    case "delivered": {
      // Final state. Set delivered_at and advance status. Don't touch
      // sent_at — the 'sent' callback handles that; if it never fired
      // (rare race), we leave sent_at null rather than overwrite with
      // a too-late timestamp.
      await admin
        .from("sms_campaign_recipients")
        .update({
          status: "delivered",
          delivered_at: now,
          updated_at: now,
        })
        .eq("id", recipient.id)
        .in("status", ["scheduled", "sending", "sent", "delivered"]);
      // Log `Received SMS` event for SendAt-scheduled sends (the
      // immediate-send path logs it at submit time). Idempotent at the
      // segmentation layer — duplicates count as one engagement slot.
      if (recipient.customer_id) {
        await admin.from("profile_events").insert({
          workspace_id: recipient.workspace_id,
          customer_id: recipient.customer_id,
          metric_name: "Received SMS",
          datetime: now,
          attributed_campaign_id: recipient.campaign_id,
        });
      }
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
