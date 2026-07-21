import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import crypto from "crypto";
import { inngest } from "@/lib/inngest/client";

// Statuses that mean the carrier says the package is at the destination
// and no further tracking events are expected. `available_for_pickup` is
// USPS post office / locker delivery — the return is IN and the refund
// should fire; before Phase 2 the code stamped the return as delivered
// on this status but never fired `returns/process-delivery`, so the
// return sat forever. Keep both in one set — one source of truth for
// what "delivered" means to the refund rail.
const DELIVERED_TRACKER_STATUSES = new Set(["delivered", "available_for_pickup"]);

// EasyPost sends tracker.updated events when tracking status changes.
// We match by easypost_shipment_id or tracking_number to update our returns table.

/**
 * EasyPost signature format. Real headers look like:
 *   X-Hmac-Signature:    hmac-sha256-hex=c829e211b0ad...
 *   X-Hmac-Signature-V2: hmac-sha256-hex=f73bb65d14e9...
 *   X-Timestamp:         Tue, 28 Apr 2026 13:37:29 -0000
 *
 * V1 = HMAC-SHA256(body, secret).hex()
 * V2 = HMAC-SHA256(timestamp + body, secret).hex()  ← preferred
 *
 * Compare against the hex AFTER stripping the "hmac-sha256-hex=" prefix.
 * timingSafeEqual on equal-length Buffers won't throw.
 */
function verifyEasyPostHmac(
  rawBody: string,
  v1Signature: string | null,
  v2Signature: string | null,
  timestamp: string | null,
  secret: string,
): boolean {
  const stripPrefix = (s: string | null) => s?.replace(/^hmac-sha256-hex=/i, "").trim() || null;
  const v1Hex = stripPrefix(v1Signature);
  const v2Hex = stripPrefix(v2Signature);

  // Try V2 first (preferred — includes timestamp for replay protection)
  if (v2Hex && timestamp) {
    const expected = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("hex");
    if (expected.length === v2Hex.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v2Hex, "hex"))) return true;
      } catch { /* fall through to V1 */ }
    }
  }

  // Fall back to V1
  if (v1Hex) {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (expected.length === v1Hex.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1Hex, "hex"))) return true;
      } catch { /* falsy below */ }
    }
  }

  return false;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  let eventBody: Record<string, unknown>;
  try {
    eventBody = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Verify HMAC signature if we have a webhook secret
  const v1Sig = request.headers.get("x-hmac-signature");
  const v2Sig = request.headers.get("x-hmac-signature-v2");
  const tsHeader = request.headers.get("x-timestamp");
  if (v1Sig || v2Sig) {
    const admin = createAdminClient();
    const { data: workspaces } = await admin.from("workspaces")
      .select("id, easypost_webhook_secret")
      .not("easypost_webhook_secret", "is", null);

    let verified = false;
    for (const ws of workspaces || []) {
      try {
        const secret = decrypt(ws.easypost_webhook_secret);
        if (verifyEasyPostHmac(rawBody, v1Sig, v2Sig, tsHeader, secret)) {
          verified = true;
          break;
        }
      } catch { /* try next workspace */ }
    }

    if (!verified) {
      console.error("[easypost-webhook] HMAC verification failed", { hasV1: !!v1Sig, hasV2: !!v2Sig, hasTs: !!tsHeader });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  // EasyPost webhook events have a description field
  const description = eventBody.description as string | undefined;
  if (!description?.startsWith("tracker.")) {
    // We only care about tracker events
    return NextResponse.json({ ok: true });
  }

  const result = eventBody.result as {
    id?: string;
    tracking_code?: string;
    status?: string;
    shipment_id?: string;
    carrier?: string;
    est_delivery_date?: string;
    tracking_details?: {
      status: string;
      message: string;
      datetime: string;
    }[];
  } | undefined;

  if (!result?.tracking_code) {
    return NextResponse.json({ ok: true });
  }

  const admin = createAdminClient();

  // Find the return by tracking number or easypost shipment ID
  let returnRecord;

  if (result.shipment_id) {
    const { data } = await admin
      .from("returns")
      .select("id, workspace_id, status")
      .eq("easypost_shipment_id", result.shipment_id)
      .single();
    returnRecord = data;
  }

  if (!returnRecord) {
    const { data } = await admin
      .from("returns")
      .select("id, workspace_id, status")
      .eq("tracking_number", result.tracking_code)
      .single();
    returnRecord = data;
  }

  if (!returnRecord) {
    // Not a return we're tracking
    console.log(`[easypost-webhook] No return found for tracking ${result.tracking_code}`);
    return NextResponse.json({ ok: true });
  }

  const trackerStatus = result.status;
  const updates: Record<string, string | null> = {
    updated_at: new Date().toISOString(),
  };

  // Map EasyPost tracker status to our return status
  switch (trackerStatus) {
    case "in_transit":
    case "out_for_delivery":
      updates.status = "in_transit";
      if (!returnRecord.status || returnRecord.status === "label_created") {
        updates.shipped_at = new Date().toISOString();
      }
      break;

    case "delivered":
    case "available_for_pickup":
      // Phase 2 EasyPost webhook gap: this branch already stamped the
      // return as delivered for BOTH statuses, but the event dispatch
      // below only fired for the literal "delivered" — so an
      // `available_for_pickup` return was a permanently-stuck one. The
      // event trigger below now checks DELIVERED_TRACKER_STATUSES so
      // both paths converge on `returns/process-delivery`.
      updates.status = "delivered";
      updates.delivered_at = new Date().toISOString();
      break;

    case "pre_transit":
      // Label created but not yet picked up — keep current status
      break;

    case "failure":
    case "error":
    case "cancelled":
    case "return_to_sender":
      // Create a dashboard notification for these
      console.warn(
        `[easypost-webhook] Tracking issue for return ${returnRecord.id}: ${trackerStatus}`,
      );
      await admin.from("dashboard_notifications").insert({
        workspace_id: returnRecord.workspace_id,
        type: "system",
        title: `Return tracking issue: ${trackerStatus}`,
        body: `Tracking ${result.tracking_code} status is ${trackerStatus}. Please investigate.`,
        metadata: {
          return_id: returnRecord.id,
          tracking_code: result.tracking_code,
          tracker_status: trackerStatus,
        },
      });
      break;
  }

  if (Object.keys(updates).length > 1) {
    // Phase 2 EasyPost webhook gap: this update's error was previously
    // unchecked; the code flowed straight into the event fire even when
    // the return row never actually updated (so the refund could fire on
    // a stale status). Check + bail loudly with a 500 so EasyPost's own
    // retry policy engages — a returns row that never advanced to
    // delivered is a stuck one, and silently returning 200 hides it.
    const { error: updErr } = await admin
      .from("returns")
      .update(updates)
      .eq("id", returnRecord.id);
    if (updErr) {
      console.error(
        `[easypost-webhook] returns update failed for ${returnRecord.id} (tracking ${result.tracking_code}):`,
        updErr,
      );
      return NextResponse.json(
        { error: "returns update failed", detail: updErr.message },
        { status: 500 },
      );
    }
  }

  // On delivery, fire an Inngest event for processing. Phase 2 EasyPost
  // webhook gap: the previous raw `fetch` to inn.gs (a) fired for the
  // literal "delivered" status only — an `available_for_pickup` return
  // was permanently stuck — (b) never inspected the response status,
  // (c) silently sent NOTHING when `INNGEST_EVENT_KEY` was unset while
  // still returning 200 so EasyPost never retried, and (d) swallowed
  // any throw to `console.error`. Use the `inngest` client (as
  // `returnsProcessDelivery` itself does) and fail loudly (500) so
  // EasyPost's own retries engage. Both delivered statuses converge on
  // one dispatch site via DELIVERED_TRACKER_STATUSES.
  if (trackerStatus && DELIVERED_TRACKER_STATUSES.has(trackerStatus)) {
    try {
      await inngest.send({
        name: "returns/process-delivery",
        data: {
          return_id: returnRecord.id,
          workspace_id: returnRecord.workspace_id,
        },
      });
    } catch (err) {
      console.error(
        `[easypost-webhook] inngest.send returns/process-delivery failed for ${returnRecord.id} (tracking ${result.tracking_code}, status ${trackerStatus}):`,
        err,
      );
      return NextResponse.json(
        {
          error: "inngest dispatch failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ ok: true });
}
