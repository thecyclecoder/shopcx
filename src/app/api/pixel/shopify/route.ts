/**
 * Shopify web-pixel collector → Meta Conversions API.
 *
 * The Shopify web pixel ([[shopify-extension/extensions/meta-pixel]]) runs in a
 * strict sandbox: no DOM, so no `fbevents.js`. It forwards each analytics event
 * here and THIS route signs it into Meta's CAPI via [[../../../../lib/meta-capi]]
 * `sendCapiEvents`. Doing the send server-side means:
 *   - the CAPI access token never ships to client code
 *   - one verified send path instead of hand-rolling Meta's /tr query format
 *     against an endpoint that answers with a 1x1 gif
 *   - real `client_ip_address` + `client_user_agent`, which the sandbox can't
 *     report about itself
 *
 * Purchase arrives BOTH here (browser) and from the `orders/create` webhook
 * (server, with hashed PII off the order). Both derive the same
 * `shopify_purchase_{orderId}` event id, so Meta collapses them into one
 * conversion and keeps the richer copy.
 *
 * PUBLIC + UNAUTHENTICATED — it is called from a shopper's browser, so it must
 * be treated as hostile input. Guards below: pixel id must match the configured
 * sink, event name must be one we map, and numeric fields are coerced. A bad
 * body is dropped with 204 rather than 4xx so a probing client learns nothing
 * and the storefront never sees an error.
 */
import { NextResponse } from "next/server";
import { getActiveMetaSink, sendCapiEvents, type CapiUserData } from "@/lib/meta-capi";
import { createAdminClient } from "@/lib/supabase/admin";

/** Meta standard events this collector will forward. Anything else is dropped —
 *  an open relay into our pixel would let anyone inject arbitrary conversions. */
const ALLOWED_EVENTS = new Set([
  "PageView",
  "ViewContent",
  "AddToCart",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
  // Fired by window.scxTrackLead from the theme pixel when the SMS/email
  // collector captures a contact. Meta's standard "handed over contact info"
  // event — powers Lead-optimised campaigns and subscriber lookalikes.
  "Lead",
]);

/** Meta rejects event_time older than 7 days; also bounds clock-skewed clients. */
const MAX_EVENT_AGE_SEC = 6 * 24 * 60 * 60;

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const eventName = String(body.eventName ?? "");
  const eventId = String(body.eventId ?? "");
  const pixelId = String(body.pixelId ?? "");
  if (!ALLOWED_EVENTS.has(eventName) || !eventId || !pixelId) {
    return new NextResponse(null, { status: 204 });
  }

  // Resolve the workspace from the pixel id itself — the sandbox has no session
  // and we will not trust a workspace id supplied by the client.
  const admin = createAdminClient();
  const { data: sinkRow } = await admin
    .from("event_sinks")
    .select("workspace_id")
    .eq("sink_type", "meta_capi")
    .eq("is_active", true)
    .eq("config->>pixel_id", pixelId)
    .maybeSingle();
  if (!sinkRow?.workspace_id) return new NextResponse(null, { status: 204 });

  const sink = await getActiveMetaSink(sinkRow.workspace_id as string);
  // Re-check: the sink we send through must be the pixel the client named, so a
  // forged pixelId can never route events into a different workspace's dataset.
  if (!sink || sink.pixelId !== pixelId) return new NextResponse(null, { status: 204 });

  const nowSec = Math.floor(Date.now() / 1000);
  const rawMs = Number(body.eventTimeMs);
  const eventTimeSec = Number.isFinite(rawMs) ? Math.floor(rawMs / 1000) : nowSec;
  const boundedTime = Math.min(Math.max(eventTimeSec, nowSec - MAX_EVENT_AGE_SEC), nowSec);

  const userData: CapiUserData = {
    email: typeof body.email === "string" ? body.email : null,
    // Lead events carry a phone when the collector captured one for SMS —
    // `ph` is a strong Meta match key and the browser has no other source for it.
    phone: typeof body.phone === "string" ? body.phone : null,
    externalId: body.customerId != null ? String(body.customerId) : null,
    fbp: typeof body.fbp === "string" ? body.fbp : null,
    fbc: typeof body.fbc === "string" ? body.fbc : null,
    clientIp: clientIp(request),
    clientUserAgent: request.headers.get("user-agent"),
  };

  const custom = (body.customData ?? {}) as Record<string, unknown>;

  const res = await sendCapiEvents(sink, [
    {
      eventName,
      eventId,
      eventTimeSec: boundedTime,
      eventSourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : null,
      userData,
      customData: custom,
    },
  ]);

  // Always 204 to the shopper's browser. Meta failures are ours to observe, not
  // the storefront's to react to; the pixel is fire-and-forget by design.
  if (!res.ok) {
    console.warn(`[pixel/shopify] CAPI ${res.status} for ${eventName} ${eventId}: ${res.body.slice(0, 300)}`);
  }
  return new NextResponse(null, { status: 204 });
}
