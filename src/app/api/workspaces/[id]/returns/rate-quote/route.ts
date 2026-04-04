import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getReturnShippingRate } from "@/lib/easypost";

// POST — get a return shipping rate quote without buying
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

  const { order_id } = body;
  if (!order_id) {
    return NextResponse.json({ error: "order_id is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Look up order with shipping address from fulfillments JSONB
  const { data: order } = await admin
    .from("orders")
    .select("id, shopify_order_id, line_items, fulfillments, total_price_cents, order_number")
    .eq("id", order_id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  // Extract shipping address from the order fulfillments or line items
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

  // Try to get shipping address from first fulfillment
  const shippingAddress = fulfillments[0]?.shipping_address;
  if (!shippingAddress?.address1 || !shippingAddress?.city || !shippingAddress?.zip) {
    return NextResponse.json(
      { error: "No shipping address found on order fulfillments" },
      { status: 400 },
    );
  }

  // Get product weights for line items
  const lineItems = (order.line_items || []) as {
    title?: string;
    quantity?: number;
    product_id?: string;
    variant_id?: string;
  }[];

  // Look up product weights from products table
  const productIds = lineItems
    .map((li) => li.product_id)
    .filter(Boolean) as string[];

  const productWeights = new Map<string, { weight: number; weightUnit: string }>();
  if (productIds.length > 0) {
    const { data: products } = await admin
      .from("products")
      .select("shopify_product_id, variants")
      .eq("workspace_id", workspaceId)
      .in("shopify_product_id", productIds);

    for (const product of products || []) {
      const variants = (product.variants || []) as {
        id?: string;
        weight?: number;
        weight_unit?: string;
      }[];
      for (const v of variants) {
        if (v.id && v.weight) {
          productWeights.set(v.id, {
            weight: v.weight,
            weightUnit: v.weight_unit || "g",
          });
        }
      }
    }
  }

  const rateLineItems = lineItems.map((li) => {
    const variantWeight = li.variant_id ? productWeights.get(li.variant_id) : undefined;
    return {
      title: li.title || "Unknown",
      quantity: li.quantity || 1,
      weight: variantWeight?.weight || null,
      weightUnit: variantWeight?.weightUnit || null,
    };
  });

  try {
    const result = await getReturnShippingRate(workspaceId, {
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
      lineItems: rateLineItems,
    });

    const orderTotalCents = order.total_price_cents || 0;
    const netRefundCents = Math.max(0, orderTotalCents - result.rate.costCents);

    return NextResponse.json({
      shipment_id: result.shipmentId,
      rate: {
        id: result.rate.id,
        carrier: result.rate.carrier,
        service: result.rate.service,
        cost_cents: result.rate.costCents,
        estimated_days: result.rate.estimatedDays,
      },
      order_total_cents: orderTotalCents,
      net_refund_cents: netRefundCents,
    });
  } catch (err) {
    console.error("[rate-quote] Failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get rate quote" },
      { status: 500 },
    );
  }
}
