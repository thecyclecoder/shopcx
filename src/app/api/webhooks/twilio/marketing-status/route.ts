/**
 * Twilio status callback for marketing SMS sends (fast-ack).
 *
 * Configured in Twilio: Messaging Service → Integration →
 *   "Delivery status callback URL" → POST
 *   https://shopcx.ai/api/webhooks/twilio/marketing-status
 *
 * The request path does ZERO Postgres work. We verify the signature,
 * parse the URL-encoded body, and enqueue a single Inngest event
 * (`sms/status-callback.received`) that a bounded/batched drain
 * consumer processes off the request path. Prior to this the handler
 * synchronously looked up + updated sms_campaign_recipients /
 * customers / profile_events / storefront_leads inline, which caused
 * a self-DDoS at ~50k+ recipients / ~100k+ callbacks.
 *
 * Idempotency key = MessageSid (travels in the payload; the consumer
 * dedupes on it).
 */
import { NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";
import { validateTwilioSignature } from "@/lib/twilio";

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
      // 200 keeps Twilio from retrying — silent drop on bad signature.
      return new NextResponse("", { status: 200 });
    }
  }

  // Fast-ack: enqueue the callback for the drain consumer. MessageSid
  // is the idempotency key — same sid delivered twice by Twilio ends
  // in the same row state after the consumer runs.
  await inngest.send({
    name: "sms/status-callback.received",
    data: { params, url },
  });

  return new NextResponse("", { status: 200 });
}
