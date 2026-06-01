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
import { createAmplifierOrder } from "@/lib/integrations/amplifier";
import { generateOrderNumber } from "@/lib/order-number";
import { resolveRateForCart } from "@/lib/shipping-rates";
import { readVisitorContext, stitchVisitor } from "@/lib/identity-stitch";
import { checkOrderForFraud } from "@/lib/fraud-detector";
import { buildPackingSlipMessage } from "@/lib/packing-slip-message";
import { createTransaction as createAvalaraTx } from "@/lib/avalara";
import { buildAvalaraLines } from "@/lib/avalara-cart";
import crypto from "crypto";

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
  // Vault-token path: an authenticated customer picked one of their
  // saved cards. Server validates the token actually belongs to the
  // sx_session customer before charging.
  payment_method_token?: string;
  device_data?: string;
  email?: string;
  phone?: string;
  shipping_address?: AddressInput;
  billing_address?: AddressInput;
  shipping_protection_added?: boolean;
  shipping_method_code?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (!body.cart_token || !body.email || (!body.payment_method_nonce && !body.payment_method_token)) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400 });
  }
  const ship = body.shipping_address;
  if (!ship?.address1 || !ship?.city || !ship?.province_code || !ship?.zip) {
    return NextResponse.json({ error: "incomplete_shipping_address" }, { status: 400 });
  }
  const bill = body.billing_address || ship;

  const admin = createAdminClient();

  const visitorCtx = readVisitorContext(request);

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
    sku?: string | null;
    title: string;
    variant_title: string | null;
    image_url: string | null;
    quantity: number;
    unit_price_cents: number;
    unit_msrp_cents: number;
    line_total_cents: number;
    mode: "subscribe" | "onetime";
    frequency_days: number | null;
    is_gift?: boolean;
  };
  const lines = cart.line_items as Line[];
  const subtotalCents = lines.reduce((s, l) => s + l.line_total_cents, 0);
  const subscribing = lines.some((l) => l.mode === "subscribe");

  // Resolve the customer's selected shipping method against current
  // shipping_rates. The server is authoritative — even if the client
  // sent a method code that doesn't apply for this cart shape (e.g.
  // asked for expedited on a subscription where it's disabled),
  // resolveRateForCart falls back to the default. If the workspace
  // has no rates configured, error out — never fabricate a number.
  const resolved = await resolveRateForCart(cart.workspace_id, lines, body.shipping_method_code);
  if (!resolved) {
    return NextResponse.json(
      { error: "no_shipping_rate", details: "No shipping rates configured for this workspace." },
      { status: 500 },
    );
  }
  const shippingCents = resolved.total_cents;
  const shippingMethodCode: string | null = resolved.rate.code;
  const shippingRateId: string | null = resolved.rate.id;

  // Shipping protection — server validates against the workspace's
  // configured rate (client can't fabricate a different protection
  // price). When the workspace has it disabled, the flag is ignored.
  const { data: wsProtection } = await admin
    .from("workspaces")
    .select("shipping_protection_enabled, shipping_protection_price_cents, shipping_protection_title, avalara_enabled")
    .eq("id", cart.workspace_id)
    .single();
  const protectionEnabled = !!wsProtection?.shipping_protection_enabled;
  const protectionAdded = protectionEnabled && body.shipping_protection_added === true;
  const protectionCents = protectionAdded ? (wsProtection?.shipping_protection_price_cents || 0) : 0;
  const protectionTitle = (wsProtection?.shipping_protection_title as string | null) || "Shipping Protection";

  // ── Tax (Avalara) ────────────────────────────────────────────────
  // Compute the authoritative tax BEFORE charging Braintree, using
  // the order_number we're about to assign as the AvaTax document
  // code. type=SalesInvoice + commit=true → the transaction is
  // recorded for filing the moment the customer's card is charged.
  //
  // If Avalara isn't enabled OR fails, fall back to 0 so the
  // checkout doesn't break. We log the failure so an operator can
  // reconcile manually.
  //
  // We use the same `buildAvalaraLines` helper as the quote endpoint
  // so the customer-displayed quote and the committed invoice agree
  // (Avalara is deterministic for identical inputs).
  const orderNumber = await generateOrderNumber(cart.workspace_id);

  const customerEmailForAvalara = body.email.trim().toLowerCase();
  let taxCents = 0;
  let avalaraTransactionCode: string | null = null;
  if (wsProtection?.avalara_enabled) {
    try {
      const avalaraLines = await buildAvalaraLines({
        admin,
        workspaceId: cart.workspace_id,
        lines,
        shippingCents,
        shippingMethodLabel: resolved.rate.name || resolved.rate.code || "Shipping",
        protectionCents,
        protectionTitle,
      });
      if (avalaraLines.length > 0) {
        const avalaraResult = await createAvalaraTx(cart.workspace_id, {
          code: orderNumber,
          customerCode: customerEmailForAvalara,
          date: new Date().toISOString().slice(0, 10),
          commit: true,
          type: "SalesInvoice",
          lines: avalaraLines,
          shipTo: {
            line1: ship.address1!,
            line2: ship.address2,
            city: ship.city!,
            region: ship.province_code!.toUpperCase(),
            postalCode: ship.zip!,
            country: (ship.country_code || "US").toUpperCase(),
          },
        });
        if (avalaraResult.success) {
          taxCents = avalaraResult.totalTaxCents ?? 0;
          avalaraTransactionCode = avalaraResult.transactionCode || orderNumber;
        } else {
          console.warn(`[checkout] Avalara commit failed for ${orderNumber}:`, avalaraResult.error);
        }
      }
    } catch (err) {
      console.warn(`[checkout] Avalara commit threw for ${orderNumber}:`, err);
    }
  }

  const totalCents = subtotalCents + shippingCents + taxCents + protectionCents;

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

  // 4. Resolve the vault token to charge.
  //    NEW path (saved card): customer picked one of their stored
  //    methods. We validate the token actually belongs to this
  //    customer (anti-token-replay) and skip the vault step entirely.
  //    LEGACY path (nonce): vault the new card first so it survives a
  //    mid-flight failure, then charge.
  let savedPm: { id: string };
  let chargeToken: string;
  if (body.payment_method_token) {
    const { data: existing } = await admin
      .from("customer_payment_methods")
      .select("id, braintree_payment_method_token")
      .eq("workspace_id", cart.workspace_id)
      .eq("customer_id", customer.id)
      .eq("status", "active")
      .eq("braintree_payment_method_token", body.payment_method_token)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ error: "saved_card_not_found" }, { status: 400 });
    }
    savedPm = { id: existing.id };
    chargeToken = existing.braintree_payment_method_token;
  } else {
    let vaulted;
    try {
      vaulted = await vaultPaymentMethod(
        cart.workspace_id,
        braintreeCustomerId,
        body.payment_method_nonce!,
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
    savedPm = await savePaymentMethod({
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
    chargeToken = vaulted.token;
  }

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
    paymentMethodToken: chargeToken,
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

  // ── 5a. Insert a pending transactions row BEFORE the sale. ──────
  // If the function dies mid-flight we still know we tried to charge.
  // The row gets patched to succeeded/failed once Braintree responds.
  const { data: txnRow } = await admin
    .from("transactions")
    .insert({
      workspace_id: cart.workspace_id,
      customer_id: customer.id,
      payment_method_id: savedPm.id,
      type: "initial_checkout",
      status: "pending",
      amount_cents: totalCents,
      currency: "USD",
      braintree_payment_method_token: chargeToken,
      braintree_customer_id: braintreeCustomerId,
      metadata: { cart_token: cart.token },
    })
    .select("id")
    .single();
  const transactionRecordId = txnRow?.id as string | undefined;

  // ── 5b. Run the sale. ────────────────────────────────────────────
  const txnResult = await gateway.transaction.sale(txnInput);
  if (!txnResult.success || !txnResult.transaction) {
    const message =
      txnResult.message ||
      (txnResult as { transaction?: { processorResponseText?: string } }).transaction?.processorResponseText ||
      "Braintree transaction failed";
    if (transactionRecordId) {
      await admin.from("transactions").update({
        status: "failed",
        error_message: message,
        processor_response_code: (txnResult as { transaction?: { processorResponseCode?: string } }).transaction?.processorResponseCode || null,
        processor_response_text: (txnResult as { transaction?: { processorResponseText?: string } }).transaction?.processorResponseText || null,
        updated_at: new Date().toISOString(),
      }).eq("id", transactionRecordId);
    }
    // We already committed the Avalara invoice for this orderNumber
    // (locks it for filing). Since the customer never paid, void it
    // so we don't owe tax on a non-transaction. The customer can
    // retry — the next attempt re-quotes a fresh code.
    if (avalaraTransactionCode) {
      try {
        const { voidTransaction } = await import("@/lib/avalara");
        await voidTransaction(cart.workspace_id, avalaraTransactionCode);
      } catch (err) {
        console.warn(`[checkout] Avalara void after Braintree fail threw for ${orderNumber}:`, err);
      }
    }
    return NextResponse.json({
      error: "transaction_failed",
      details: message,
      // Card stays vaulted; surface the token so a retry can reuse it.
      braintree_payment_method_token: chargeToken,
      braintree_customer_id: braintreeCustomerId,
    }, { status: 402 });
  }
  const transaction = txnResult.transaction;
  const paymentMethodToken: string = chargeToken;

  // Patch transactions row with success.
  if (transactionRecordId) {
    await admin.from("transactions").update({
      status: "succeeded",
      braintree_transaction_id: transaction.id,
      processor_response_code: transaction.processorResponseCode,
      processor_response_text: transaction.processorResponseText,
      updated_at: new Date().toISOString(),
    }).eq("id", transactionRecordId);
  }

  // ── 6. Create internal subscription rows for any subscribe lines. ─
  // Group by frequency_days so one cart with two different cadences
  // produces two subs. Skip if no subscribe lines.
  type SubscribeBucket = { frequency_days: number; items: typeof lines };
  const buckets = new Map<number, SubscribeBucket>();
  for (const l of lines) {
    if (l.mode !== "subscribe" || !l.frequency_days) continue;
    if (!buckets.has(l.frequency_days)) buckets.set(l.frequency_days, { frequency_days: l.frequency_days, items: [] });
    buckets.get(l.frequency_days)!.items.push(l);
  }

  const createdSubscriptionIds: string[] = [];
  let primarySubscriptionId: string | null = null;
  for (const bucket of buckets.values()) {
    const nextBillingDate = new Date();
    nextBillingDate.setDate(nextBillingDate.getDate() + bucket.frequency_days);
    const contractId = `internal-${crypto.randomBytes(8).toString("hex")}`;
    // delivery_price_cents = the shipping cost portion of the recurring
    // charge. For subscriptions we currently default to free economy
    // shipping; expedited would carry a non-zero value here on the
    // recurring renewal too. The subscription's recurring total is the
    // implicit sum of items[].price_cents * quantity + delivery_price_cents.
    const subDeliveryCents = bucket.items.some((i) => i.mode === "subscribe") ? 0 : shippingCents;
    const { data: sub, error: subErr } = await admin
      .from("subscriptions")
      .insert({
        workspace_id: cart.workspace_id,
        customer_id: customer.id,
        shopify_customer_id: customer.shopify_customer_id || null,
        shopify_contract_id: contractId,
        status: "active",
        billing_interval: "day",
        billing_interval_count: bucket.frequency_days,
        next_billing_date: nextBillingDate.toISOString(),
        // Free gifts are first-order-only — they don't persist as
        // recurring subscription line items. The customer keeps the
        // gift from their initial order, but the next renewal ships
        // only the paid products they actually subscribed to.
        items: bucket.items
          .filter((i) => !i.is_gift)
          .map((i) => ({
            variant_id: i.variant_id,
            product_id: i.product_id,
            shopify_variant_id: i.shopify_variant_id,
            title: i.title,
            variant_title: i.variant_title,
            image_url: i.image_url,
            quantity: i.quantity,
            price_cents: i.unit_price_cents,
            sku: undefined,
          })),
        delivery_price_cents: subDeliveryCents,
        applied_discounts: [],
        is_internal: true,
        shipping_protection_added: protectionAdded,
        shipping_protection_amount_cents: protectionAdded ? protectionCents : null,
        shipping_method_code: shippingMethodCode,
        shipping_rate_id: shippingRateId,
      })
      .select("id")
      .single();
    if (subErr) {
      // Don't swallow — the user's order succeeded but the recurring
      // record didn't. Log loudly so we notice in Vercel + can replay.
      console.error(`[checkout] subscription insert failed for cart ${cart.token}:`, subErr);
    }
    if (sub?.id) {
      createdSubscriptionIds.push(sub.id as string);
      if (!primarySubscriptionId) primarySubscriptionId = sub.id as string;
    }
  }
  // Patch the transaction record with the subscription it produced (if any).
  if (transactionRecordId && primarySubscriptionId) {
    await admin.from("transactions").update({ subscription_id: primarySubscriptionId }).eq("id", transactionRecordId);
  }

  // ── 7. Insert the order row. ────────────────────────────────────
  // orderNumber was generated earlier so we could use it as the
  // Avalara document code — same value used here for the orders row.
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
      subscription_id: primarySubscriptionId,
      payment_details: {
        subtotal_cents: subtotalCents,
        shipping_cents: shippingCents,
        tax_cents: taxCents,
        protection_cents: protectionCents,
        gateway: "braintree",
        processor_response_code: transaction.processorResponseCode,
        processor_response_text: transaction.processorResponseText,
      },
      shipping_protection_added: protectionAdded,
      shipping_protection_amount_cents: protectionAdded ? protectionCents : null,
      shipping_method_code: shippingMethodCode,
      shipping_rate_id: shippingRateId,
      avalara_transaction_code: avalaraTransactionCode,
      avalara_total_tax_cents: avalaraTransactionCode ? taxCents : null,
      avalara_committed_at: avalaraTransactionCode ? new Date().toISOString() : null,
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
      if (transactionRecordId) {
        await admin.from("transactions").update({
          status: "refunded",
          refunded_at: new Date().toISOString(),
          error_message: `Auto-refunded: order insert failed (${orderErr?.message})`,
        }).eq("id", transactionRecordId);
      }
    } catch (refundErr) {
      console.error(
        `[checkout] CRITICAL: order insert AND refund failed. Manual refund needed for txn ${transaction.id}`,
        orderErr,
        refundErr,
      );
    }
    // Also void the Avalara invoice since the order didn't actually
    // exist — we don't want tax filed on a refunded non-transaction.
    if (avalaraTransactionCode) {
      try {
        const { voidTransaction } = await import("@/lib/avalara");
        await voidTransaction(cart.workspace_id, avalaraTransactionCode);
      } catch (voidErr) {
        console.warn(`[checkout] Avalara void after order_insert_failed threw for ${orderNumber}:`, voidErr);
      }
    }
    return NextResponse.json(
      { error: "order_insert_failed", details: orderErr?.message, braintree_transaction_id: transaction.id },
      { status: 500 },
    );
  }

  // Patch the transactions row with the resulting order_id.
  if (transactionRecordId) {
    await admin.from("transactions").update({ order_id: order.id }).eq("id", transactionRecordId);
  }

  // ── 8. Post-payment fraud check. ─────────────────────────────────
  // Runs the full rule engine (shared_address, high_velocity, address
  // distance, name mismatch, amazon_reseller w/ fuzzy match) on the
  // new order row. Once Amplifier ingests the order it goes to the
  // 3PL pick queue and becomes effectively un-cancellable, so this
  // gate is non-negotiable. The held state is implicit: an order
  // with no amplifier_order_id + an open fraud_case is held.
  // The dismiss action on the case is what eventually fires Amplifier.
  let fraudHeld = false;
  try {
    await checkOrderForFraud(cart.workspace_id, order.id, customer.id);
    // fraud_cases.order_ids is a text[] array — use contains() to find
    // cases that include this order's UUID.
    const { data: openCases } = await admin
      .from("fraud_cases")
      .select("id, rule_type, severity")
      .eq("workspace_id", cart.workspace_id)
      .contains("order_ids", [order.id])
      .neq("status", "dismissed");
    if (openCases && openCases.length > 0) {
      fraudHeld = true;
      const ruleTypes = openCases.map((c) => c.rule_type).join(", ");
      console.warn(`[checkout] order ${order.order_number} held post-payment: ${ruleTypes}`);
      await admin.from("dashboard_notifications").insert({
        workspace_id: cart.workspace_id,
        type: "fraud_alert",
        title: `${order.order_number} held — fraud review required`,
        message: `Order paid via Braintree but NOT released to fulfillment. Rules fired: ${ruleTypes}. Dismiss the case to release it to Amplifier.`,
      }).then(() => undefined, () => undefined);
    }
  } catch (err) {
    // Don't bail the entire request — order is paid + saved. Log so
    // an operator can re-run the fraud check.
    console.warn(`[checkout] post-payment fraud check threw for ${orderNumber}:`, err);
  }

  // ── 9. Hand off to Amplifier for fulfillment. ────────────────────
  // Skipped when fraud is held; the fraud-dismiss handler will fire
  // Amplifier when an operator clears the case.
  if (fraudHeld) {
    console.warn(`[checkout] skipping Amplifier for ${orderNumber} — fraud hold in place`);
  } else {
    // Founder note used BOTH on the packing slip AND in the order
    // confirmation email below — single source of truth so the
    // customer reads the same wording in the box and in the inbox.
    const distinctProducts = new Set(lines.filter((l) => l.sku).map((l) => l.product_id)).size;
    const packingSlipMessage = await buildPackingSlipMessage({
      workspaceId: cart.workspace_id,
      customerId: customer.id,
      orderId: order.id,
      firstName: ship.first_name || customer.first_name || "",
      productCount: distinctProducts,
    });
    // Stash on the order so the confirmation-email step picks it up
    // without a second Haiku call.
    (order as { _founderNote?: string })._founderNote = packingSlipMessage;
    try {
      const amplifierRes = await createAmplifierOrder({
        workspaceId: cart.workspace_id,
        orderNumber,
        orderDate: new Date().toISOString(),
        shippingAddress: ship,
        billingAddress: bill,
        email,
        phone: body.phone || ship.phone || null,
        // Send EVERY line with a SKU — including free gifts. Gifts
        // are physical products that need to ship; only filter out
        // lines that genuinely lack a fulfillment SKU.
        lineItems: lines
          .filter((l) => l.sku)
          .map((l) => ({
            sku: l.sku!,
            title: l.title,
            description: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title,
            quantity: l.quantity,
            // Gifts ship at $0 — Amplifier records the line at zero
            // so the warehouse pick sheet shows the item but the
            // value rolls into the totals as zero.
            unit_price_cents: l.unit_price_cents,
            reference_id: l.variant_id,
          })),
        totalCents,
        subtotalCents,
        shippingCents,
        taxCents,
        packingSlipMessage,
      });
      if (amplifierRes.success && amplifierRes.amplifier_order_id) {
        await admin
          .from("orders")
          .update({
            amplifier_order_id: amplifierRes.amplifier_order_id,
            amplifier_received_at: new Date().toISOString(),
          })
          .eq("id", order.id);
      } else {
        console.warn(`[checkout] Amplifier order create failed for ${orderNumber}:`, amplifierRes.error, amplifierRes.details);
      }
    } catch (err) {
      console.warn(`[checkout] Amplifier order create threw for ${orderNumber}:`, err);
    }
  }

  // ── 9. Mark cart converted. ──────────────────────────────────────
  await admin
    .from("cart_drafts")
    .update({
      status: "converted",
      converted_order_id: order.id,
      customer_id: customer.id,
      updated_at: new Date().toISOString(),
    })
    .eq("token", cart.token);

  // ── 10. Stitch identity + enrich session with device + IP-geo. ──
  // Backfills the customer_id onto any prior storefront_events with
  // this anonymous_id so the order_placed event ties to the full
  // pre-checkout funnel for attribution.
  await stitchVisitor({
    workspaceId: cart.workspace_id,
    customerId: customer.id,
    anonymousId: (cart.anonymous_id as string | null) || null,
    context: visitorCtx,
  });

  // ── 11. Order confirmation email. ────────────────────────────────
  // Best-effort — failure logs but doesn't break the response. The
  // packing slip handles the in-the-box copy; this is the inbox copy
  // with line items, totals, and (if subscribing) the next billing
  // date so the customer can see when they'll be charged next.
  try {
    const { sendOrderConfirmationEmail } = await import("@/lib/email-storefront");
    // Was this their first order with us across linked accounts?
    const { data: priorOrders } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", cart.workspace_id)
      .eq("customer_id", customer.id)
      .neq("id", order.id);
    const isFirstOrder = !priorOrders || (priorOrders as unknown as { length?: number }).length === 0;
    let nextBillingDate: string | null = null;
    if (primarySubscriptionId) {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("next_billing_date")
        .eq("id", primarySubscriptionId)
        .maybeSingle();
      nextBillingDate = (sub?.next_billing_date as string | null) || null;
    }
    // Compute "would have paid for shipping" so the email mirrors the
    // cart's strikethrough → Free treatment. Look up onetime_economy
    // shipping rate from the DB and price it against this cart's
    // chargeable units. Best-effort — falls through to no strikethrough
    // if the rate is missing.
    let shippingValueCentsForEmail: number | null = null;
    try {
      const { data: economyRate } = await admin
        .from("shipping_rates")
        .select("base_cents, per_item_cents, max_total_cents")
        .eq("workspace_id", cart.workspace_id)
        .eq("applies_to", "onetime")
        .eq("code", "economy")
        .eq("enabled", true)
        .maybeSingle();
      if (economyRate) {
        const chargeableUnits = lines.reduce((s, l) => (l.unit_price_cents > 0 ? s + l.quantity : s), 0);
        const raw = (economyRate.base_cents as number) + (economyRate.per_item_cents as number) * chargeableUnits;
        const capped = economyRate.max_total_cents != null && raw > (economyRate.max_total_cents as number)
          ? (economyRate.max_total_cents as number) : raw;
        shippingValueCentsForEmail = capped;
      }
    } catch { /* non-fatal */ }

    const sendRes = await sendOrderConfirmationEmail({
      workspaceId: cart.workspace_id,
      order: {
        id: order.id,
        order_number: order.order_number as string,
        email,
        total_cents: totalCents,
        line_items: lines,
        shipping_address: ship,
        shipping_method_code: shippingMethodCode,
        payment_details: {
          subtotal_cents: subtotalCents,
          shipping_cents: shippingCents,
          tax_cents: taxCents,
          protection_cents: protectionCents,
        },
        shipping_protection_added: protectionAdded,
        shipping_protection_amount_cents: protectionAdded ? protectionCents : null,
        subscription_id: primarySubscriptionId,
      },
      isFirstOrder,
      subscribing,
      nextBillingDate,
      // Same founder note as the packing slip — set above when we
      // didn't skip Amplifier. If we DID skip (fraud hold), no note
      // since the customer hasn't yet been promised a delivery.
      founderNote: (order as { _founderNote?: string })._founderNote || null,
      shippingValueCents: shippingValueCentsForEmail,
    });
    if (!sendRes.success) {
      console.warn(`[checkout] order confirmation email failed for ${orderNumber}: ${sendRes.error}`);
    }
  } catch (err) {
    console.warn(`[checkout] order confirmation email threw for ${orderNumber}:`, err);
  }

  return NextResponse.json({
    ok: true,
    order_id: order.id,
    order_number: order.order_number,
    braintree_transaction_id: transaction.id,
    subscription_ids: createdSubscriptionIds,
  });
}
