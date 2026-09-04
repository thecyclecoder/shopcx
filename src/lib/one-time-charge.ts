/**
 * One-time charge on a vaulted Braintree payment method.
 *
 * The gap this closes: we could bill a SUBSCRIPTION (the renewal pipeline in
 * [[inngest/internal-subscription-renewals]]) and we could take a NEW checkout
 * (`src/app/api/checkout/route.ts`), but there was no way to charge an existing
 * customer for a one-off order against the card they already have on file.
 *
 * The failing case: Susan Hall (ticket 303ef89d) asked for one box in September
 * and her normal two boxes from November. `subscriptionOrderNow` was the only
 * tool available and on an internal contract it fires a RENEWAL — it bills the
 * whole contract (2 boxes + shipping protection) and advances the schedule off
 * the November date. The only alternatives were a quantity-flip race against an
 * async charge, or asking the customer to go do it herself.
 *
 * This mirrors the checkout route's money path exactly, minus the cart:
 *
 *   1. resolve the vaulted card (must be `status='active'` with a Braintree token)
 *   2. resolve variants → price / sku / title from `product_variants`
 *   3. Avalara `SalesInvoice` commit when the workspace has tax enabled
 *   4. insert a `pending` row in `transactions` BEFORE the sale, so a crash
 *      mid-flight still leaves evidence we tried to charge
 *   5. `gateway.transaction.sale({ paymentMethodToken, submitForSettlement })`
 *   6. patch the transaction row to succeeded / failed
 *   7. insert the order
 *   8. push it to Amplifier — an order that charges but never reaches the
 *      warehouse is worse than one that never charged
 *
 * If the order INSERT fails after a successful sale we refund immediately, the
 * same way checkout does, so a DB failure can never leave a customer billed for
 * something we have no record of.
 *
 * Brain: [[../../docs/brain/libraries/one-time-charge.md]] ·
 * [[../../docs/brain/integrations/braintree.md]] ·
 * [[../../docs/brain/integrations/amplifier.md]]
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getBraintreeGateway } from "@/lib/integrations/braintree";
import { createAmplifierOrder } from "@/lib/integrations/amplifier";
import { generateOrderNumber } from "@/lib/order-number";
import { createTransaction as createAvalaraTx } from "@/lib/avalara";
import { errText } from "@/lib/error-text";

/**
 * `orders.shipping_address` is Shopify-shaped (address1 / province_code / zip /
 * country_code); Avalara wants line1 / region / postalCode / country. Returns
 * null when a required field is missing so we quote no tax rather than commit a
 * SalesInvoice against a half-formed address.
 */
export function toAvalaraAddress(
  addr: Record<string, unknown> | null,
): { line1: string; line2?: string; city: string; region: string; postalCode: string; country: string } | null {
  if (!addr) return null;
  const str = (k: string): string => {
    const v = addr[k];
    return typeof v === "string" ? v.trim() : "";
  };
  const line1 = str("address1") || str("line1");
  const city = str("city");
  const region = str("province_code") || str("province") || str("region");
  const postalCode = str("zip") || str("postalCode");
  const country = str("country_code") || str("country") || "US";
  if (!line1 || !city || !region || !postalCode) return null;
  const line2 = str("address2") || str("line2");
  return { line1, ...(line2 ? { line2 } : {}), city, region, postalCode, country };
}

export interface OneTimeChargeItem {
  /** Internal `product_variants.id` (uuid). Shopify is being sunset. */
  variant_id: string;
  quantity: number;
  /**
   * Unit price the customer is actually entitled to, in cents. Defaults to the
   * catalog `product_variants.price_cents`.
   *
   * Needed because catalog price is often NOT what the customer pays. Susan's
   * K-Cups are $79.95 in the catalog and $59.96 on her subscription line;
   * charging her a one-time box at catalog would have quietly billed her $20
   * over her own rate. Pass the subscription line's `price_cents` when the
   * one-off is standing in for a subscription shipment.
   */
  unit_price_cents?: number;
}

export interface OneTimeChargeInput {
  workspaceId: string;
  customerId: string;
  items: OneTimeChargeItem[];
  /** `customer_payment_methods.id`. Omit to use the customer's active default. */
  paymentMethodId?: string | null;
  /** Omit to reuse the address from the customer's most recent order. */
  shippingAddress?: Record<string, unknown> | null;
  /** Flat shipping charge in cents. Defaults to 0 — most one-time assists ship free. */
  shippingCents?: number;
  /** Written to `orders.source_name` so these are separable in reporting. */
  sourceName?: string;
  /** Free-text note stored on the transaction for the audit trail. */
  reason?: string;
}

export interface OneTimeChargeResult {
  success: boolean;
  order_id?: string;
  order_number?: string;
  transaction_id?: string;
  braintree_transaction_id?: string;
  amount_cents?: number;
  amplifier_order_id?: string;
  /** Set when the charge succeeded but the warehouse push did not. */
  amplifier_error?: string;
  error?: string;
  details?: string;
}

export async function chargeOneTimeOrder(
  input: OneTimeChargeInput,
): Promise<OneTimeChargeResult> {
  const { workspaceId, customerId } = input;

  // Validate BEFORE constructing anything. These guards stand between a caller
  // typo and a real card, so they must not depend on a DB client existing.
  if (!input.items?.length) return { success: false, error: "no_items" };
  for (const it of input.items) {
    if (!it.variant_id || !Number.isInteger(it.quantity) || it.quantity < 1) {
      return { success: false, error: "invalid_item" };
    }
    if (
      it.unit_price_cents !== undefined &&
      (!Number.isInteger(it.unit_price_cents) || it.unit_price_cents < 0)
    ) {
      return { success: false, error: "invalid_price_override" };
    }
  }

  const admin = createAdminClient();

  // ── 1. The card. ────────────────────────────────────────────────────
  // status='active' is the same filter the renewal uses. A card the
  // customer removed must never be charged, even if a stale
  // `subscriptions.payment_method_id` still points at it.
  const pmQuery = admin
    .from("customer_payment_methods")
    .select("id, braintree_customer_id, braintree_payment_method_token, card_brand, last4")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .eq("status", "active");
  const { data: pm } = input.paymentMethodId
    ? await pmQuery.eq("id", input.paymentMethodId).maybeSingle()
    : await pmQuery.eq("is_default", true).limit(1).maybeSingle();

  if (!pm?.braintree_payment_method_token || !pm.braintree_customer_id) {
    return { success: false, error: "no_vaulted_payment_method" };
  }

  // ── 2. The customer + line items. ───────────────────────────────────
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone, first_name, last_name, shopify_customer_id")
    .eq("id", customerId)
    .maybeSingle();
  if (!customer?.email) return { success: false, error: "customer_not_found" };

  // NO `products(title)` embed here. There is more than one FK between
  // product_variants and products, so PostgREST rejects the embed as
  // ambiguous — and because the error was discarded, the read came back
  // EMPTY and every item failed as `variant_not_found`. A wrong/ambiguous
  // select reading as zero rows is the exact failure CLAUDE.md warns about,
  // so the error is surfaced now instead of being swallowed.
  const { data: variants, error: variantErr } = await admin
    .from("product_variants")
    .select("id, sku, title, price_cents, product_id")
    .eq("workspace_id", workspaceId)
    .in(
      "id",
      input.items.map((i) => i.variant_id),
    );
  if (variantErr) {
    return { success: false, error: "variant_lookup_failed", details: variantErr.message };
  }

  type VariantRow = {
    id: string;
    sku: string | null;
    title: string | null;
    price_cents: number | null;
    product_id: string | null;
  };
  const rows = (variants || []) as VariantRow[];
  const byId = new Map<string, VariantRow>();
  for (const v of rows) byId.set(v.id, v);

  // Product titles in a second, unambiguous read.
  const productIds = [...new Set(rows.map((v) => v.product_id).filter(Boolean))] as string[];
  const productTitle = new Map<string, string>();
  if (productIds.length) {
    const { data: prods, error: prodErr } = await admin
      .from("products")
      .select("id, title")
      .in("id", productIds);
    if (prodErr) {
      return { success: false, error: "product_lookup_failed", details: prodErr.message };
    }
    for (const p of (prods || []) as Array<{ id: string; title: string | null }>) {
      if (p.title) productTitle.set(p.id, p.title);
    }
  }

  const lines: Array<Record<string, unknown>> = [];
  let subtotalCents = 0;
  for (const it of input.items) {
    const v = byId.get(it.variant_id);
    if (!v) return { success: false, error: "variant_not_found", details: it.variant_id };
    // An explicit override wins over catalog — see OneTimeChargeItem.
    const catalog = v.price_cents ?? 0;
    const unit = it.unit_price_cents ?? catalog;
    if (unit <= 0) return { success: false, error: "variant_has_no_price", details: it.variant_id };
    const lineTitle = (v.product_id ? productTitle.get(v.product_id) : null) || v.title || "Item";
    subtotalCents += unit * it.quantity;
    lines.push({
      variant_id: v.id,
      product_id: v.product_id,
      sku: v.sku,
      title: lineTitle,
      variant_title: v.title,
      quantity: it.quantity,
      price_cents: unit,
      ...(it.unit_price_cents !== undefined && it.unit_price_cents !== catalog
        ? { catalog_price_cents: catalog }
        : {}),
    });
  }

  // ── 3. Shipping address — reuse the last order's unless told otherwise. ──
  let ship = input.shippingAddress ?? null;
  if (!ship) {
    const { data: lastOrder } = await admin
      .from("orders")
      .select("shipping_address")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .not("shipping_address", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    ship = (lastOrder?.shipping_address as Record<string, unknown> | null) ?? null;
  }
  if (!ship) return { success: false, error: "no_shipping_address" };

  const shippingCents = Math.max(0, Math.trunc(input.shippingCents ?? 0));
  const orderNumber = await generateOrderNumber(workspaceId);

  // ── 4. Tax. Same guarded shape as checkout: a failure warns and
  // proceeds at zero rather than blocking a charge the customer expects.
  let taxCents = 0;
  let avalaraTransactionCode: string | null = null;
  const { data: ws } = await admin
    .from("workspaces")
    .select("avalara_enabled")
    .eq("id", workspaceId)
    .maybeSingle();
  const shipTo = toAvalaraAddress(ship);
  if (ws?.avalara_enabled && shipTo) {
    try {
      const { buildAvalaraLines } = await import("@/lib/avalara-cart");
      const avalaraLines = await buildAvalaraLines({
        admin,
        workspaceId,
        lines: lines.map((l) => ({
          variant_id: l.variant_id as string,
          product_id: (l.product_id as string | null) ?? "",
          sku: (l.sku as string | null) ?? null,
          title: l.title as string,
          variant_title: (l.variant_title as string | null) ?? null,
          quantity: l.quantity as number,
          unit_price_cents: l.price_cents as number,
          line_total_cents: (l.price_cents as number) * (l.quantity as number),
        })),
        shippingCents,
        protectionCents: 0,
      });
      if (avalaraLines.length > 0) {
        const res = await createAvalaraTx(workspaceId, {
          code: orderNumber,
          customerCode: customerId,
          date: new Date().toISOString().slice(0, 10),
          shipTo,
          type: "SalesInvoice",
          lines: avalaraLines,
          commit: true,
        });
        if (res.success) {
          taxCents = res.totalTaxCents ?? 0;
          avalaraTransactionCode = res.transactionCode || orderNumber;
        } else {
          console.warn(`[one-time-charge] Avalara failed for ${orderNumber}:`, res.error);
        }
      }
    } catch (err) {
      console.warn(`[one-time-charge] Avalara threw for ${orderNumber}:`, errText(err));
    }
  }

  const totalCents = subtotalCents + shippingCents + taxCents;
  if (totalCents <= 0) return { success: false, error: "zero_total" };

  // ── 5. Evidence before money. ───────────────────────────────────────
  // `transactions.type` is constrained to
  // initial_checkout | renewal | dunning_retry | manual | comp.
  // A CS-initiated one-off is 'manual'; `orders.source_name` and
  // metadata.reason are what distinguish it downstream. The first version of
  // this used 'one_time_charge', which violated the check constraint — and
  // because the insert discarded its error, the row silently never existed
  // and the charge went through with no evidence behind it.
  const { data: txnRow, error: txnErr } = await admin
    .from("transactions")
    .insert({
      workspace_id: workspaceId,
      customer_id: customerId,
      payment_method_id: pm.id,
      type: "manual",
      status: "pending",
      amount_cents: totalCents,
      currency: "USD",
      braintree_payment_method_token: pm.braintree_payment_method_token,
      braintree_customer_id: pm.braintree_customer_id,
      metadata: {
        order_number: orderNumber,
        reason: input.reason ?? null,
        kind: "one_time_charge",
      },
    })
    .select("id")
    .single();

  // FAIL CLOSED. This row is the whole point of writing evidence before money:
  // if we cannot record that we are about to charge, we do not charge. Better a
  // customer who has to be told "try again" than a card charged against nothing.
  if (txnErr || !txnRow?.id) {
    return {
      success: false,
      error: "transaction_record_failed",
      details: txnErr?.message ?? "insert returned no row",
    };
  }
  const transactionRecordId = txnRow.id as string;

  // ── 6. The sale. ────────────────────────────────────────────────────
  const gateway = await getBraintreeGateway(workspaceId);
  const sale = await gateway.transaction.sale({
    amount: (totalCents / 100).toFixed(2),
    paymentMethodToken: pm.braintree_payment_method_token,
    customerId: pm.braintree_customer_id,
    options: { submitForSettlement: true },
  });

  if (!sale.success || !sale.transaction) {
    const message =
      sale.message ||
      (sale as { transaction?: { processorResponseText?: string } }).transaction
        ?.processorResponseText ||
      "Braintree transaction failed";
    await admin
      .from("transactions")
      .update({ status: "failed", error_message: message })
      .eq("id", transactionRecordId);
    return { success: false, error: "charge_declined", details: message };
  }
  const transaction = sale.transaction;

  await admin
    .from("transactions")
    .update({ status: "succeeded", braintree_transaction_id: transaction.id })
    .eq("id", transactionRecordId);

  // ── 7. The order. ───────────────────────────────────────────────────
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      workspace_id: workspaceId,
      customer_id: customerId,
      shopify_customer_id: customer.shopify_customer_id || null,
      shopify_order_id: null,
      order_number: orderNumber,
      email: customer.email,
      total_cents: totalCents,
      currency: "USD",
      financial_status: "paid",
      fulfillment_status: null,
      line_items: lines,
      source_name: input.sourceName || "one-time-charge",
      shipping_address: ship,
      billing_address: ship,
      braintree_transaction_id: transaction.id,
      braintree_payment_method_token: pm.braintree_payment_method_token,
      braintree_customer_id: pm.braintree_customer_id,
      discount_codes: [],
      payment_details: {
        subtotal_cents: subtotalCents,
        discount_cents: 0,
        shipping_cents: shippingCents,
        tax_cents: taxCents,
        gateway: "braintree",
        processor_response_code: transaction.processorResponseCode,
        processor_response_text: transaction.processorResponseText,
        one_time_reason: input.reason ?? null,
        // Any line priced off-catalog is recorded so an audit can see the
        // charge was deliberate rather than a stale-price bug.
        price_overrides: lines
          .filter((l) => l.catalog_price_cents !== undefined)
          .map((l) => ({
            sku: l.sku,
            charged_cents: l.price_cents,
            catalog_cents: l.catalog_price_cents,
          })),
      },
      avalara_transaction_code: avalaraTransactionCode,
      avalara_total_tax_cents: avalaraTransactionCode ? taxCents : null,
      avalara_committed_at: avalaraTransactionCode ? new Date().toISOString() : null,
    })
    .select("id, order_number")
    .single();

  if (orderErr || !order) {
    // Charged but unrecorded — refund rather than leave the customer billed
    // for something no one can find. Mirrors the checkout route.
    try {
      await gateway.transaction.refund(transaction.id);
      await admin
        .from("transactions")
        .update({ status: "refunded", error_message: "order insert failed" })
        .eq("id", transactionRecordId);
    } catch (refundErr) {
      console.error(
        `[one-time-charge] REFUND FAILED for braintree txn ${transaction.id} — reconcile by hand:`,
        errText(refundErr),
      );
    }
    return { success: false, error: "order_insert_failed", details: orderErr?.message };
  }

  await admin.from("transactions").update({ order_id: order.id }).eq("id", transactionRecordId);

  // ── 8. The warehouse. ───────────────────────────────────────────────
  // A charge that never reaches Amplifier is a customer who paid and gets
  // nothing, so a failure here is reported on the result rather than
  // swallowed — the caller must not tell the customer it shipped.
  let amplifierOrderId: string | undefined;
  let amplifierError: string | undefined;
  try {
    const amp = await createAmplifierOrder({
      workspaceId,
      orderNumber: order.order_number as string,
      orderDate: new Date().toISOString(),
      shippingAddress: ship,
      billingAddress: ship,
      email: customer.email,
      phone: customer.phone || undefined,
      lineItems: lines
        .filter((l) => l.sku)
        .map((l) => ({
          sku: l.sku as string,
          title: l.title as string,
          description: l.variant_title
            ? `${l.title as string} — ${l.variant_title as string}`
            : (l.title as string),
          quantity: l.quantity as number,
          unit_price_cents: l.price_cents as number,
        })),
    });

    if (amp.success && amp.amplifier_order_id) {
      amplifierOrderId = amp.amplifier_order_id;
      await admin
        .from("orders")
        .update({
          amplifier_order_id: amp.amplifier_order_id,
          amplifier_received_at: new Date().toISOString(),
          amplifier_last_error: null,
        })
        .eq("id", order.id);
    } else {
      amplifierError = amp.error || "amplifier_create_failed";
      await admin
        .from("orders")
        .update({ amplifier_last_error: amplifierError })
        .eq("id", order.id);
    }
  } catch (err) {
    amplifierError = errText(err);
    await admin.from("orders").update({ amplifier_last_error: amplifierError }).eq("id", order.id);
  }

  return {
    success: true,
    order_id: order.id as string,
    order_number: order.order_number as string,
    transaction_id: transactionRecordId,
    braintree_transaction_id: transaction.id,
    amount_cents: totalCents,
    amplifier_order_id: amplifierOrderId,
    amplifier_error: amplifierError,
  };
}
