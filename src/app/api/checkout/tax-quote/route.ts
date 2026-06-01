/**
 * POST /api/checkout/tax-quote
 *
 * Returns an Avalara sales-tax quote for the current cart given a
 * shipping address. Called from CheckoutClient on every meaningful
 * address/shipping/protection change, debounced.
 *
 * Avalara call: createTransaction({ commit: false, type: "SalesOrder" })
 * — non-filing, non-charging. Idempotent on `code = "cart-<token>"`.
 *
 * Falls back to { tax_cents: 0, enabled: false } when Avalara isn't
 * configured for the workspace so dev/test environments aren't gated.
 *
 * Body:
 *   {
 *     cart_token: required
 *     shipping_address: { address1, city, province_code, zip, country_code? }
 *     shipping_method_code?: string  // active shipping rate code
 *     shipping_protection_added?: boolean
 *   }
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveRateForCart } from "@/lib/shipping-rates";
import { createTransaction } from "@/lib/avalara";
import { buildAvalaraLines, type CartLineForTax } from "@/lib/avalara-cart";

interface AddressInput {
  address1?: string;
  address2?: string;
  city?: string;
  province_code?: string;
  zip?: string;
  country_code?: string;
}

interface PostBody {
  cart_token?: string;
  shipping_address?: AddressInput;
  shipping_method_code?: string;
  shipping_protection_added?: boolean;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (!body.cart_token) {
    return NextResponse.json({ error: "missing_cart_token" }, { status: 400 });
  }
  const addr = body.shipping_address;
  if (!addr?.address1 || !addr?.city || !addr?.province_code || !addr?.zip) {
    // Not enough info to quote — silently return zero. The client
    // already knows; this is just a polite no-op.
    return NextResponse.json({ tax_cents: 0, enabled: false, reason: "incomplete_address" });
  }

  const admin = createAdminClient();

  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id, token, line_items, status")
    .eq("token", body.cart_token)
    .maybeSingle();
  if (!cart) return NextResponse.json({ error: "cart_not_found" }, { status: 404 });
  if (cart.status !== "open") return NextResponse.json({ tax_cents: 0, enabled: false, reason: "cart_not_open" });

  const lines = (cart.line_items as CartLineForTax[]) || [];
  if (lines.length === 0) return NextResponse.json({ tax_cents: 0, enabled: false, reason: "empty_cart" });

  // Check Avalara is configured + enabled for this workspace
  const { data: ws } = await admin
    .from("workspaces")
    .select("avalara_enabled, shipping_protection_enabled, shipping_protection_price_cents, shipping_protection_title")
    .eq("id", cart.workspace_id)
    .single();
  if (!ws?.avalara_enabled) {
    return NextResponse.json({ tax_cents: 0, enabled: false, reason: "avalara_not_enabled" });
  }

  // Resolve the customer's selected shipping rate — server is the
  // price authority for shipping. Tax depends on the resolved rate,
  // not the client-claimed code.
  const resolved = await resolveRateForCart(cart.workspace_id as string, lines, body.shipping_method_code);
  const shippingCents = resolved?.total_cents ?? 0;
  const shippingMethodLabel = resolved?.rate.name || resolved?.rate.code || "Shipping";

  // Protection — same server-validated treatment as final checkout
  const protectionEnabled = !!ws?.shipping_protection_enabled;
  const protectionAdded = protectionEnabled && body.shipping_protection_added === true;
  const protectionCents = protectionAdded ? (ws?.shipping_protection_price_cents || 0) : 0;
  const protectionTitle = (ws?.shipping_protection_title as string | null) || "Shipping Protection";

  const avalaraLines = await buildAvalaraLines({
    admin,
    workspaceId: cart.workspace_id as string,
    lines,
    shippingCents,
    shippingMethodLabel,
    protectionCents,
    protectionTitle,
  });

  if (avalaraLines.length === 0) {
    return NextResponse.json({ tax_cents: 0, enabled: true, reason: "no_taxable_lines" });
  }

  // Pull a stable customer reference for Avalara — email is the best
  // we have at quote time (the cart may not have a customer_id yet).
  const { data: cartFull } = await admin
    .from("cart_drafts")
    .select("email, customer_id")
    .eq("token", body.cart_token)
    .maybeSingle();
  const customerCode = cartFull?.customer_id || cartFull?.email || `cart-${body.cart_token}`;

  const result = await createTransaction(cart.workspace_id as string, {
    code: `cart-${body.cart_token}`,
    customerCode,
    date: new Date().toISOString().slice(0, 10),
    commit: false,
    type: "SalesOrder",
    lines: avalaraLines,
    shipTo: {
      line1: addr.address1!,
      line2: addr.address2,
      city: addr.city!,
      region: addr.province_code!.toUpperCase(),
      postalCode: addr.zip!,
      country: (addr.country_code || "US").toUpperCase(),
    },
  });

  if (!result.success) {
    console.warn(`[tax-quote] Avalara quote failed for cart ${body.cart_token}:`, result.error);
    return NextResponse.json({ tax_cents: 0, enabled: true, error: result.error });
  }

  const taxCents = result.totalTaxCents ?? 0;

  // Persist the quote on the cart for analytics + so the
  // abandoned-cart email can show the same tax.
  await admin
    .from("cart_drafts")
    .update({
      avalara_quote_tax_cents: taxCents,
      avalara_quote_at: new Date().toISOString(),
    })
    .eq("token", body.cart_token);

  return NextResponse.json({
    tax_cents: taxCents,
    enabled: true,
    breakdown: result.lines || [],
  });
}
