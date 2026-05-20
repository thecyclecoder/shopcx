/**
 * GET /api/checkout/shipping-rates?cart_token=...
 *
 * Returns the shipping options applicable to the current cart with
 * their computed totals. The cart shape (subscribing vs one-time) +
 * chargeable units (excluding freebies) determines pricing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  chargeableUnits as chargeableUnitsOf,
  listRatesForCart,
  priceRate,
  type ShippingAppliesTo,
  type ShippingRate,
} from "@/lib/shipping-rates";

interface CartLine {
  quantity: number;
  unit_price_cents: number;
  mode?: "subscribe" | "onetime";
}

export async function GET(request: NextRequest) {
  const cartToken = request.nextUrl.searchParams.get("cart_token");
  if (!cartToken) {
    return NextResponse.json({ error: "missing_cart_token" }, { status: 400 });
  }
  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id, line_items")
    .eq("token", cartToken)
    .maybeSingle();
  if (!cart) return NextResponse.json({ error: "cart_not_found" }, { status: 404 });

  const lines = (cart.line_items as CartLine[]) || [];
  const subscribing = lines.some((l) => l.mode === "subscribe");
  const applies_to: ShippingAppliesTo = subscribing ? "subscription" : "onetime";
  const rates = await listRatesForCart(cart.workspace_id as string, lines);

  // For the strikethrough display on subscribing carts we also need
  // the onetime_economy total — what the customer would have paid
  // had they checked out as a one-time shopper. Looked up directly
  // from shipping_rates so nothing is hardcoded.
  let onetime_economy_cents: number | null = null;
  if (subscribing) {
    const { data: row } = await admin
      .from("shipping_rates")
      .select("*")
      .eq("workspace_id", cart.workspace_id as string)
      .eq("applies_to", "onetime")
      .eq("code", "economy")
      .eq("enabled", true)
      .maybeSingle();
    if (row) {
      onetime_economy_cents = priceRate(row as ShippingRate, chargeableUnitsOf(lines));
    }
  }

  return NextResponse.json({
    applies_to,
    onetime_economy_cents,
    rates: rates.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      transit_days_min: r.transit_days_min,
      transit_days_max: r.transit_days_max,
      total_cents: r.total_cents,
      is_default: r.is_default,
    })),
  });
}
