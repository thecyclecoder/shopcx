import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getReturnShippingRate, purchaseReturnLabel } from "@/lib/easypost";
import { attachReturnTracking } from "@/lib/shopify-returns";
import { sendReturnLabelEmail } from "@/lib/easypost-email";

// POST — create (or buy) a return label via EasyPost
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { return_id, order_id, shipment_id } = body;
  if (!return_id || !order_id) {
    return NextResponse.json(
      { error: "return_id and order_id are required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Look up return record
  const { data: ret } = await admin
    .from("returns")
    .select("id, order_number, customer_id, order_total_cents, status")
    .eq("id", return_id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret) {
    return NextResponse.json({ error: "Return not found" }, { status: 404 });
  }

  // Look up order for shipping address
  const { data: order } = await admin
    .from("orders")
    .select("id, fulfillments, line_items, total_price_cents")
    .eq("id", order_id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  try {
    let label;

    if (shipment_id) {
      // Phase 2: Buy an existing shipment (from rate quote)
      label = await purchaseReturnLabel(workspaceId, shipment_id);
    } else {
      // No shipment_id — create new shipment + get rates + buy cheapest
      const fulfillments = (order.fulfillments || []) as {
        shipping_address?: {
          first_name?: string;
          last_name?: string;
          name?: string;
          address1?: string;
          address2?: string;
          city?: string;
          province_code?: string;
          zip?: string;
          country_code?: string;
          phone?: string;
        };
      }[];

      const shippingAddress = fulfillments[0]?.shipping_address;
      if (!shippingAddress?.address1 || !shippingAddress?.city || !shippingAddress?.zip) {
        return NextResponse.json(
          { error: "No shipping address found on order fulfillments" },
          { status: 400 },
        );
      }

      const lineItems = (order.line_items || []) as {
        title?: string;
        quantity?: number;
      }[];

      // Get rate + buy in one flow
      const rateResult = await getReturnShippingRate(workspaceId, {
        customerAddress: {
          name: shippingAddress.name ||
            `${shippingAddress.first_name || ""} ${shippingAddress.last_name || ""}`.trim(),
          street1: shippingAddress.address1,
          street2: shippingAddress.address2 || undefined,
          city: shippingAddress.city,
          state: shippingAddress.province_code || "",
          zip: shippingAddress.zip,
          country: shippingAddress.country_code || "US",
          phone: shippingAddress.phone || undefined,
        },
        lineItems: lineItems.map((li) => ({
          title: li.title || "Unknown",
          quantity: li.quantity || 1,
          weight: null,
          weightUnit: null,
        })),
      });

      label = await purchaseReturnLabel(
        workspaceId,
        rateResult.shipmentId,
        rateResult.rate.id,
      );
    }

    const orderTotalCents = ret.order_total_cents || order.total_price_cents || 0;
    const netRefundCents = Math.max(0, orderTotalCents - label.costCents);

    // Update the returns record
    await admin
      .from("returns")
      .update({
        tracking_number: label.trackingNumber,
        carrier: label.carrier,
        label_url: label.labelUrl,
        label_cost_cents: label.costCents,
        net_refund_cents: netRefundCents,
        easypost_shipment_id: shipment_id || null,
        status: "label_created",
        updated_at: new Date().toISOString(),
      })
      .eq("id", return_id);

    // Attach tracking in Shopify
    try {
      await attachReturnTracking(workspaceId, {
        returnId: return_id,
        trackingNumber: label.trackingNumber,
        carrier: label.carrier,
        labelUrl: label.labelUrl,
      });
    } catch (err) {
      console.error("[create-label] Failed to attach Shopify tracking:", err);
      // Non-fatal — label is created, just Shopify tracking failed
    }

    // Email the label to the customer
    if (ret.customer_id) {
      const { data: customer } = await admin
        .from("customers")
        .select("email, first_name")
        .eq("id", ret.customer_id)
        .single();

      if (customer?.email) {
        try {
          await sendReturnLabelEmail({
            workspaceId,
            toEmail: customer.email,
            customerName: customer.first_name || null,
            orderNumber: ret.order_number,
            trackingNumber: label.trackingNumber,
            carrier: label.carrier,
            labelUrl: label.labelUrl,
            labelCostCents: label.costCents,
            orderTotalCents,
            netRefundCents,
            resolutionType: "refund", // Will be updated by caller if store credit
          });
        } catch (err) {
          console.error("[create-label] Failed to email label:", err);
        }
      }
    }

    return NextResponse.json({
      tracking_number: label.trackingNumber,
      label_url: label.labelUrl,
      carrier: label.carrier,
      label_cost_cents: label.costCents,
      net_refund_cents: netRefundCents,
    });
  } catch (err) {
    console.error("[create-label] Failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create label" },
      { status: 500 },
    );
  }
}
