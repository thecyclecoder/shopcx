/**
 * POST /api/checkout
 *
 * The one-shot endpoint that turns a cart_draft into a paid order.
 * Vault-first ordering: the card is in our payment_methods table
 * BEFORE we ever attempt the charge, so a mid-flight transaction
 * failure leaves us with a usable card to retry against (no
 * "customer re-enters card data after a network blip").
 *
 *   1. Resolve + validate the cart by token
 *   2. Recompute pricing (server is the price authority — client never
 *      tells us what to charge)
 *   3. Resolve or create the customer record
 *   4. Resolve the Braintree customer id (local → BT search by email
 *      → create — see lib/integrations/braintree-customer.ts)
 *   5. Vault the card: paymentMethod.create(nonce, verifyCard=true).
 *      Persist customer_payment_methods row with type / brand / last4 /
 *      expiry / token. This row exists BEFORE the charge.
 *   6. Charge: transaction.sale({ paymentMethodToken }) — the
 *      already-vaulted token, not the original nonce. If this fails
 *      we surface the error; the card is still in our DB and the
 *      customer can retry.
 *   7. Insert the order row, mark the cart converted, return the
 *      order id so the client can redirect to /thank-you.
 *
 * Shipping/tax for now:
 *   - Subscribing: free shipping, $0 tax (real tax service ships later)
 *   - One-time:    $4.95 per unit shipping, $0 tax
 *
 * Body shape:
 *   {
 *     cart_token:           required
 *     payment_method_nonce: required
 *     device_data:          required (Braintree fraud signal)
 *     email:                required
 *     phone?:               optional
 *     shipping_address: { first_name, last_name, address1, address2?,
 *                         city, province_code, zip, country_code, phone? }
 *     billing_address?:     same shape — defaults to shipping_address
 *   }
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBraintreeGateway } from "@/lib/integrations/braintree";
import {
  resolveBraintreeCustomerId,
  vaultPaymentMethod,
  savePaymentMethod,
} from "@/lib/integrations/braintree-customer";

const ESTIMATED_SHIPPING_PER_ITEM_CENTS = 495;

interface AddressInput {
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province_code?: string;
  zip?: string;
  country_code?: string;
  phone?: string;
}

interface PostBody {
  cart_token?: string;
  payment_method_nonce?: string;
  device_data?: string;
  email?: string;
  phone?: string;
  shipping_address?: AddressInput;
  billing_address?: AddressInput;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (!body.cart_token || !body.payment_method_nonce || !body.email) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400 });
  }
  const ship = body.shipping_address;
  if (!ship?.address1 || !ship?.city || !ship?.province_code || !ship?.zip) {
    return NextResponse.json({ error: "incomplete_shipping_address" }, { status: 400 });
  }
  const bill = body.billing_address || ship;

  const admin = createAdminClient();

  // 1. Load + validate cart
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("*")
    .eq("token", body.cart_token)
    .maybeSingle();
  if (!cart) return NextResponse.json({ error: "cart_not_found" }, { status: 404 });
  if (cart.status !== "open") return NextResponse.json({ error: "cart_not_open" }, { status: 400 });
  if (!Array.isArray(cart.line_items) || cart.line_items.length === 0) {
    return NextResponse.json({ error: "cart_empty" }, { status: 400 });
  }

  type Line = {
    variant_id: string;
    product_id: string;
    shopify_variant_id: string | null;
    title: string;
    variant_title: string | null;
    image_url: string | null;
    quantity: number;
    unit_price_cents: number;
    unit_msrp_cents: number;
    line_total_cents: number;
    mode: "subscribe" | "onetime";
    frequency_days: number | null;
  };
  const lines = cart.line_items as Line[];
  const subtotalCents = lines.reduce((s, l) => s + l.line_total_cents, 0);
  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);
  const subscribing = lines.some((l) => l.mode === "subscribe");
  const shippingCents = subscribing ? 0 : totalUnits * ESTIMATED_SHIPPING_PER_ITEM_CENTS;
  const taxCents = 0;  // TODO: TaxJar / Avalara integration
  const totalCents = subtotalCents + shippingCents + taxCents;

  if (totalCents <= 0) {
    return NextResponse.json({ error: "invalid_total" }, { status: 400 });
  }

  // 2. Resolve / create the customer record. Match by email within
  //    the workspace; create a fresh row if no match.
  const email = body.email.trim().toLowerCase();
  let { data: customer } = await admin
    .from("customers")
    .select("id, shopify_customer_id, first_name, last_name")
    .eq("workspace_id", cart.workspace_id)
    .ilike("email", email)
    .maybeSingle();

  if (!customer) {
    const { data: created, error: createErr } = await admin
      .from("customers")
      .insert({
        workspace_id: cart.workspace_id,
        email,
        first_name: ship.first_name || null,
        last_name: ship.last_name || null,
        phone: body.phone || ship.phone || null,
        subscription_status: subscribing ? "active" : "never",
      })
      .select("id, shopify_customer_id, first_name, last_name")
      .single();
    if (createErr || !created) {
      return NextResponse.json({ error: "customer_create_failed", details: createErr?.message }, { status: 500 });
    }
    customer = created;
  }

  // 3. Resolve the Braintree customer id (local → BT search → create)
  //    BEFORE we touch the card so the new card attaches to a stable
  //    BT customer record we'll reuse on the next checkout / renewal.
  let braintreeCustomerId: string;
  try {
    braintreeCustomerId = await resolveBraintreeCustomerId({
      workspaceId: cart.workspace_id,
      customerId: customer.id,
      email,
      firstName: ship.first_name || customer.first_name,
      lastName: ship.last_name || customer.last_name,
      phone: body.phone || ship.phone,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "braintree_customer_resolve_failed", details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // 4. Vault FIRST — gateway.paymentMethod.create({ nonce, verifyCard }).
  //    Card lives in our DB before we attempt the charge so a mid-flight
  //    failure doesn't lose it. paymentMethod.create's verifyCard option
  //    runs a $0 / $1 auth check, which means an invalid card surfaces
  //    here instead of inside the transaction.sale call.
  let vaulted;
  try {
    vaulted = await vaultPaymentMethod(
      cart.workspace_id,
      braintreeCustomerId,
      body.payment_method_nonce,
      body.device_data,
    );
  } catch (err) {
    return NextResponse.json(
      { error: "card_verification_failed", details: err instanceof Error ? err.message : String(err) },
      { status: 402 },
    );
  }

  // Persist the payment method. is_default=true via savePaymentMethod
  // semantics (the newest vault wins) — customer/admin can flip later.
  await savePaymentMethod({
    workspaceId: cart.workspace_id,
    customerId: customer.id,
    braintreeCustomerId,
    braintreePaymentMethodToken: vaulted.token,
    paymentType: vaulted.paymentType,
    cardBrand: vaulted.cardBrand,
    last4: vaulted.last4,
    expirationMonth: vaulted.expirationMonth,
    expirationYear: vaulted.expirationYear,
    cartToken: cart.token,
    makeDefault: true,
  });

  // 5. Charge against the vaulted token (NOT the nonce — that's now
  //    consumed). If the sale fails the card stays vaulted; the customer
  //    can retry with the same payment method.
  let gateway;
  try {
    gateway = await getBraintreeGateway(cart.workspace_id);
  } catch (err) {
    return NextResponse.json(
      { error: "braintree_not_configured", details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const amountDecimal = (totalCents / 100).toFixed(2);
  const txnInput = {
    amount: amountDecimal,
    paymentMethodToken: vaulted.token,
    customerId: braintreeCustomerId,
    deviceData: body.device_data,
    billing: {
      firstName: bill.first_name || ship.first_name || "",
      lastName: bill.last_name || ship.last_name || "",
      streetAddress: bill.address1 || "",
      extendedAddress: bill.address2 || "",
      locality: bill.city || "",
      region: bill.province_code || "",
      postalCode: bill.zip || "",
      countryCodeAlpha2: bill.country_code || "US",
    },
    shipping: {
      firstName: ship.first_name || "",
      lastName: ship.last_name || "",
      streetAddress: ship.address1 || "",
      extendedAddress: ship.address2 || "",
      locality: ship.city || "",
      region: ship.province_code || "",
      postalCode: ship.zip || "",
      countryCodeAlpha2: ship.country_code || "US",
    },
    options: {
      submitForSettlement: true,
    },
  };

  const txnResult = await gateway.transaction.sale(txnInput);
  if (!txnResult.success || !txnResult.transaction) {
    const message =
      txnResult.message ||
      (txnResult as { transaction?: { processorResponseText?: string } }).transaction?.processorResponseText ||
      "Braintree transaction failed";
    return NextResponse.json({
      error: "transaction_failed",
      details: message,
      // Card stays vaulted; surface the token so a retry can reuse it.
      braintree_payment_method_token: vaulted.token,
      braintree_customer_id: braintreeCustomerId,
    }, { status: 402 });
  }
  const transaction = txnResult.transaction;
  const paymentMethodToken: string = vaulted.token;

  // 4. Insert the order row + mark cart converted.
  const orderNumber = `SX${Date.now().toString().slice(-8)}`;
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      workspace_id: cart.workspace_id,
      customer_id: customer.id,
      shopify_customer_id: customer.shopify_customer_id || null,
      shopify_order_id: null,
      order_number: orderNumber,
      email,
      total_cents: totalCents,
      currency: "USD",
      financial_status: "paid",
      fulfillment_status: null,
      line_items: lines,
      source_name: "storefront",
      shipping_address: ship,
      billing_address: bill,
      braintree_transaction_id: transaction.id,
      braintree_payment_method_token: paymentMethodToken,
      braintree_customer_id: braintreeCustomerId,
      cart_token: cart.token,
      payment_details: {
        subtotal_cents: subtotalCents,
        shipping_cents: shippingCents,
        tax_cents: taxCents,
        gateway: "braintree",
        processor_response_code: transaction.processorResponseCode,
        processor_response_text: transaction.processorResponseText,
      },
    })
    .select("id, order_number")
    .single();

  if (orderErr || !order) {
    // The charge succeeded but our DB write failed. Refund + surface
    // the error so the customer doesn't get double-billed when they
    // retry. Logs the txn id so an operator can reconcile if even the
    // refund fails.
    try {
      await gateway.transaction.refund(transaction.id);
    } catch (refundErr) {
      console.error(
        `[checkout] CRITICAL: order insert AND refund failed. Manual refund needed for txn ${transaction.id}`,
        orderErr,
        refundErr,
      );
    }
    return NextResponse.json(
      { error: "order_insert_failed", details: orderErr?.message, braintree_transaction_id: transaction.id },
      { status: 500 },
    );
  }

  await admin
    .from("cart_drafts")
    .update({
      status: "converted",
      converted_order_id: order.id,
      customer_id: customer.id,
      updated_at: new Date().toISOString(),
    })
    .eq("token", cart.token);

  return NextResponse.json({
    ok: true,
    order_id: order.id,
    order_number: order.order_number,
    braintree_transaction_id: transaction.id,
  });
}
