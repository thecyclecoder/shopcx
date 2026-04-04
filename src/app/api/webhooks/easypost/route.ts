import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// EasyPost sends tracker.updated events when tracking status changes.
// We match by easypost_shipment_id or tracking_number to update our returns table.

export async function POST(request: Request) {
  let eventBody: Record<string, unknown>;
  try {
    eventBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
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
      console.error(
        `[easypost-webhook] Tracking issue for return ${returnRecord.id}: ${trackerStatus}`,
      );
      await admin.from("dashboard_notifications").insert({
        workspace_id: returnRecord.workspace_id,
        type: "system",
        title: `Return tracking issue: ${trackerStatus}`,
        message: `Tracking ${result.tracking_code} status is ${trackerStatus}. Please investigate.`,
        metadata: {
          return_id: returnRecord.id,
          tracking_code: result.tracking_code,
          tracker_status: trackerStatus,
        },
      });
      break;
  }

  if (Object.keys(updates).length > 1) {
    // More than just updated_at
    await admin.from("returns").update(updates).eq("id", returnRecord.id);
  }

  // On delivery, fire an Inngest event for processing
  if (trackerStatus === "delivered") {
    try {
      const inngestKey = process.env.INNGEST_EVENT_KEY;
      if (inngestKey) {
        await fetch("https://inn.gs/e/" + inngestKey, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "returns/process-delivery",
            data: {
              return_id: returnRecord.id,
              workspace_id: returnRecord.workspace_id,
            },
          }),
        });
      }
    } catch (err) {
      console.error("[easypost-webhook] Failed to fire Inngest event:", err);
    }
  }

  return NextResponse.json({ ok: true });
}
