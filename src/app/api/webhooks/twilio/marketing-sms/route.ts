/**
 * Marketing-shortcode inbound webhook (fast-ack).
 *
 * Twilio POSTs here for every message sent TO our marketing shortcode
 * (85041) — STOP / START keywords, autoresponder replies, HELP, etc.
 *
 * The request path does ZERO Postgres work. We verify the signature,
 * parse the URL-encoded body, and enqueue a single Inngest event
 * (`sms/inbound.received`) that a bounded/batched drain consumer
 * processes off the request path. The consumer handles the workspace
 * lookup, phone match, consent flip (Shopify sync), inbound-log
 * insert, and dedupe-gated autoresponse — all previously inline on
 * this handler.
 *
 * The autoresponder previously used TwiML in the response body. It's
 * now sent out-of-band by the drain consumer via the Twilio API. STOP
 * / START confirmations are still handled by Twilio's Advanced
 * Opt-Out at the carrier edge (unchanged).
 *
 * Twilio Console config: Phone Numbers → Short Codes → 85041
 *   "A message comes in" → POST https://shopcx.ai/api/webhooks/twilio/marketing-sms
 */
import { NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";
import { validateTwilioSignature } from "@/lib/twilio";

export async function POST(request: Request) {
  const text = await request.text();
  const params: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { params[k] = v; });

  // Verify Twilio signature in production. The webhook URL must match
  // exactly what's configured in the Twilio console.
  const signature = request.headers.get("x-twilio-signature") || "";
  const webhookUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai"}/api/webhooks/twilio/marketing-sms`;
  if (process.env.NODE_ENV === "production" && !validateTwilioSignature(signature, webhookUrl, params)) {
    console.error("[marketing-sms] Invalid Twilio signature");
    // 200 empty body — silent drop on bad signature (preserve prior behavior).
    return new NextResponse("", { status: 200 });
  }

  // Fast-ack: enqueue the inbound for the drain consumer. MessageSid
  // is the idempotency key — same sid delivered twice by Twilio ends
  // in the same row state after the consumer runs.
  await inngest.send({
    name: "sms/inbound.received",
    data: { params, url: webhookUrl },
  });

  return new NextResponse("", { status: 200 });
}
