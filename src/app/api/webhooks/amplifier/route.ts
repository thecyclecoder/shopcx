import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }

  let body: {
    id: string;
    type: string;
    timestamp: string;
    data: {
      id: string;
      reference_id?: string;
      order_source?: string;
      method?: string;
      tracking_number?: string;
      date?: string;
      items?: { sku: string; description: string; quantity: number }[];
    };
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type, data } = body;

  if (!type || !data?.id) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Find workspace by webhook token
  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, amplifier_webhook_token_encrypted")
    .not("amplifier_webhook_token_encrypted", "is", null);

  let workspaceId: string | null = null;
  for (const ws of workspaces || []) {
    try {
      const decrypted = decrypt(ws.amplifier_webhook_token_encrypted);
      if (decrypted === token) {
        workspaceId = ws.id;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!workspaceId) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const referenceId = data.reference_id;

  if (type === "order.received") {
    if (!referenceId) {
      return NextResponse.json({ error: "Missing reference_id" }, { status: 400 });
    }

    // Match reference_id to order_number — Amplifier sends the numeric part,
    // our orders have a prefix (e.g., SC126823). Try both exact and with common prefixes.
    const { data: order } = await admin
      .from("orders")
      .select("id, order_number")
      .eq("workspace_id", workspaceId)
      .or(`order_number.eq.${referenceId},order_number.ilike.%${referenceId}`)
      .limit(1)
      .single();

    if (!order) {
      // Order not in our DB yet — could arrive later via Shopify webhook
      return NextResponse.json({ ok: true, matched: false });
    }

    await admin
      .from("orders")
      .update({
        amplifier_order_id: data.id,
        amplifier_received_at: body.timestamp,
        amplifier_status: "Processing Shipment",
      })
      .eq("id", order.id);

    return NextResponse.json({ ok: true, matched: true, order_id: order.id });
  }

  if (type === "order.shipped") {
    // Try matching by amplifier_order_id first, then by reference_id
    let orderId: string | null = null;

    const { data: byAmpId } = await admin
      .from("orders")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("amplifier_order_id", data.id)
      .limit(1)
      .single();

    if (byAmpId) {
      orderId = byAmpId.id;
    } else if (referenceId) {
      const { data: byRef } = await admin
        .from("orders")
        .select("id")
        .eq("workspace_id", workspaceId)
        .or(`order_number.eq.${referenceId},order_number.ilike.%${referenceId}`)
        .limit(1)
        .single();

      if (byRef) orderId = byRef.id;
    }

    if (!orderId) {
      return NextResponse.json({ ok: true, matched: false });
    }

    await admin
      .from("orders")
      .update({
        amplifier_order_id: data.id,
        amplifier_shipped_at: data.date || body.timestamp,
        amplifier_tracking_number: data.tracking_number || null,
        amplifier_carrier: data.method || null,
        amplifier_status: "Shipped",
      })
      .eq("id", orderId);

    return NextResponse.json({ ok: true, matched: true, order_id: orderId });
  }

  // Unknown event type — acknowledge it
  return NextResponse.json({ ok: true, type });
}
