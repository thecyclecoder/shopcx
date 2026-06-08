/**
 * Internal subscription renewal pipeline.
 *
 *   1. Daily cron picks every internal sub whose next_billing_date is
 *      today (or already in the past, which would mean a prior cron
 *      missed it).
 *   2. For each due sub, fire one `internal-subscription/renewal-attempt`
 *      event. Concurrency-controlled fan-out so 400 renewals don't
 *      hammer Braintree all at once.
 *   3. Per-sub handler: charge → transactions row → on success: order +
 *      Amplifier; on failure: dunning event (existing dunning system
 *      handles retries).
 *
 * Date math: subscriptions store billing_interval='day' + count for
 * internal subs (set at /api/checkout time). Advancing the next date
 * is just nextBillingDate + N days.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBraintreeGateway } from "@/lib/integrations/braintree";
import { createAmplifierOrder } from "@/lib/integrations/amplifier";
import { generateOrderNumber } from "@/lib/order-number";

// ─── Daily cron (3 AM Central) ──────────────────────────────────────
// 9 AM UTC is 3 AM CST in winter, 4 AM CDT in summer. We accept the
// 1-hour DST drift because renewal timing is idempotent — even if a
// sub doesn't get picked up on day N at exactly 3 AM, the next-day
// run picks it up. Matches `auto-archive`'s pattern.
export const internalSubscriptionRenewalCron = inngest.createFunction(
  {
    id: "internal-subscription-renewal-cron",
    name: "Internal subscription renewals — daily fan-out",
    retries: 1,
    triggers: [{ cron: "0 9 * * *" }],  // 9 AM UTC = 3 AM CST / 4 AM CDT
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const due = await step.run("find-due-subs", async () => {
      // Catch anything due today (or earlier — backfills any prior
      // missed runs). End-of-day window so subs scheduled for any time
      // today are eligible.
      const endOfToday = new Date();
      endOfToday.setUTCHours(23, 59, 59, 999);
      const { data } = await admin
        .from("subscriptions")
        .select("id, workspace_id, shopify_contract_id")
        .eq("is_internal", true)
        .eq("status", "active")
        .lte("next_billing_date", endOfToday.toISOString());
      return data || [];
    });

    // Fan out one event per sub. Inngest's concurrency control on the
    // attempt function caps how many run at once.
    if (due.length > 0) {
      await step.sendEvent("renewal-events", due.map((s) => ({
        name: "internal-subscription/renewal-attempt",
        data: { subscription_id: s.id, workspace_id: s.workspace_id },
      })));
    }

    return { dispatched: due.length };
  },
);

// ─── Per-sub renewal handler ────────────────────────────────────────
// Concurrency 10 globally. Each invocation handles one sub end-to-end:
// charge → transaction row → order + Amplifier OR dunning.
export const internalSubscriptionRenewalAttempt = inngest.createFunction(
  {
    id: "internal-subscription-renewal-attempt",
    name: "Internal subscription renewal — single sub",
    retries: 3,
    concurrency: [{ limit: 10 }],
    triggers: [{ event: "internal-subscription/renewal-attempt" }],
  },
  async ({ event, step }) => {
    const { subscription_id, workspace_id } = event.data as {
      subscription_id: string;
      workspace_id: string;
    };

    const admin = createAdminClient();

    // ── 1. Load sub + customer + default payment method ──────────
    const ctx = await step.run("load-context", async () => {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("id, workspace_id, customer_id, items, billing_interval, billing_interval_count, next_billing_date, status, applied_discounts, shopify_contract_id, is_internal, delivery_price_cents, shipping_protection_added, shipping_protection_amount_cents, shipping_method_code, shipping_address")
        .eq("id", subscription_id)
        .single();
      if (!sub?.is_internal) return { skip: true, reason: "not_internal" } as const;
      if (sub.status !== "active") return { skip: true, reason: `status_${sub.status}` } as const;
      if (!sub.customer_id) return { skip: true, reason: "no_customer" } as const;

      const { data: pm } = await admin
        .from("customer_payment_methods")
        .select("id, braintree_customer_id, braintree_payment_method_token")
        .eq("workspace_id", workspace_id)
        .eq("customer_id", sub.customer_id)
        .eq("status", "active")
        .eq("is_default", true)
        .maybeSingle();
      if (!pm) return { skip: true, reason: "no_payment_method" } as const;

      const { data: customer } = await admin
        .from("customers")
        .select("id, email, first_name, last_name, phone, shopify_customer_id")
        .eq("id", sub.customer_id)
        .single();
      if (!customer) return { skip: true, reason: "customer_not_found" } as const;

      // Pull a shipping address. Subscriptions don't carry one on the
      // row yet — derive from the most recent order for this customer.
      const { data: lastOrder } = await admin
        .from("orders")
        .select("shipping_address, billing_address")
        .eq("customer_id", sub.customer_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return {
        skip: false,
        sub,
        pm,
        customer,
        shipping_address: (lastOrder?.shipping_address as Record<string, unknown> | null) || null,
        billing_address: (lastOrder?.billing_address as Record<string, unknown> | null) || null,
      } as const;
    });

    if (ctx.skip) return { skipped: true, reason: ctx.reason };

    // ── 2. Compute charge amount ────────────────────────────────
    // Prices are DERIVED from the catalog + pricing rules (quantity break × S&S,
    // grandfathered overrides) — never read from a baked value on the row. The
    // engine returns per-line charged prices; we snapshot them as the order's
    // line items (an order is a historical record, so it DOES bake the price).
    const { resolveSubscriptionPricing } = await import("@/lib/pricing");
    const pricing = await resolveSubscriptionPricing(workspace_id, ctx.sub);
    const items = pricing.lines
      .filter((l) => l.kind === "product")
      .map((l) => ({
        variant_id: l.variant_id,
        sku: l.sku || undefined,
        title: l.title,
        variant_title: l.variant_title || undefined,
        quantity: l.quantity,
        price_cents: l.unit_cents,
      }));
    const subtotalCents = pricing.product_subtotal_cents;
    // Free shipping is a pricing-rule decision; falls back to the sub's locked rate.
    const shippingCents = pricing.shipping_cents;
    const protectionCents = ctx.sub.shipping_protection_added
      ? Number(ctx.sub.shipping_protection_amount_cents || 0)
      : 0;

    // Apply entire-order coupon discounts (consumes recurring_cycle_limit on a
    // successful charge — persisted in the advance-billing step below). NOTE:
    // tax is still quoted on the pre-discount subtotal via Avalara; applying
    // the discount to the taxable base is a documented refinement (spec § 1b).
    const { computeAppliedDiscountCents } = await import("@/lib/coupons");
    const { discountCents, nextAppliedDiscounts } = computeAppliedDiscountCents(
      (ctx.sub.applied_discounts as Array<Record<string, unknown>> | null) ?? null,
      subtotalCents,
    );

    // Reserve the order number NOW so we can use it as the Avalara
    // document code. The orders row gets inserted with this same
    // value below.
    const orderNumber = await step.run("reserve-order-number", async () => {
      return generateOrderNumber(workspace_id);
    });

    // Authoritative tax via Avalara (commit=true, SalesInvoice).
    // Returns null when Avalara isn't enabled or inputs are
    // insufficient — in that case we fall back to $0 tax + log.
    const taxResult = await step.run("avalara-commit", async () => {
      const { commitSubscriptionRenewalTax } = await import("@/lib/avalara-subscription");
      return commitSubscriptionRenewalTax(workspace_id, {
        subscriptionId: subscription_id,
        orderNumber,
        items,
        shippingAddress: ctx.shipping_address || ctx.sub.shipping_address,
        shippingCents,
        shippingMethodLabel: (ctx.sub.shipping_method_code as string | null) || "Shipping",
        protectionCents,
        customerEmail: ctx.customer.email || null,
      });
    });
    const taxCents = taxResult?.tax_cents ?? 0;
    const avalaraTransactionCode = taxResult?.transaction_code || null;

    const totalCents = Math.max(0, subtotalCents - discountCents) + shippingCents + protectionCents + taxCents;
    if (totalCents <= 0) {
      return { skipped: true, reason: "zero_total" };
    }

    // ── 3. Insert pending transactions row ──────────────────────
    const txnRowId = await step.run("insert-pending-transaction", async () => {
      const { data: row } = await admin
        .from("transactions")
        .insert({
          workspace_id,
          customer_id: ctx.sub.customer_id,
          subscription_id,
          payment_method_id: ctx.pm.id,
          type: "renewal",
          status: "pending",
          amount_cents: totalCents,
          currency: "USD",
          braintree_payment_method_token: ctx.pm.braintree_payment_method_token,
          braintree_customer_id: ctx.pm.braintree_customer_id,
        })
        .select("id")
        .single();
      return (row?.id as string) || "";
    });

    // ── 4. Charge ───────────────────────────────────────────────
    const charge = await step.run("braintree-sale", async () => {
      const gateway = await getBraintreeGateway(workspace_id);
      const result = await gateway.transaction.sale({
        amount: (totalCents / 100).toFixed(2),
        paymentMethodToken: ctx.pm.braintree_payment_method_token,
        customerId: ctx.pm.braintree_customer_id,
        options: { submitForSettlement: true },
      });
      return {
        success: !!result.success,
        message: result.message,
        transactionId: result.transaction?.id || null,
        processorResponseCode: result.transaction?.processorResponseCode || null,
        processorResponseText: result.transaction?.processorResponseText || null,
      };
    });

    // ── 5. Update transactions row ──────────────────────────────
    if (txnRowId) {
      await admin.from("transactions").update({
        status: charge.success ? "succeeded" : "failed",
        braintree_transaction_id: charge.transactionId,
        processor_response_code: charge.processorResponseCode,
        processor_response_text: charge.processorResponseText,
        error_message: charge.success ? null : charge.message,
        updated_at: new Date().toISOString(),
      }).eq("id", txnRowId);
    }

    if (!charge.success) {
      // Void the Avalara invoice we committed before the charge —
      // we filed tax for a renewal that didn't actually happen.
      if (avalaraTransactionCode) {
        await step.run("avalara-void-on-failed-charge", async () => {
          try {
            const { voidTransaction } = await import("@/lib/avalara");
            await voidTransaction(workspace_id, avalaraTransactionCode);
          } catch (err) {
            console.warn(`[renewal] Avalara void after Braintree fail threw for ${orderNumber}:`, err);
          }
        });
      }
      // Failure → dunning. We just fire the existing event so the
      // dunning pipeline picks it up. The dunning function decides
      // skip / pause / retry based on workspace config.
      await step.sendEvent("dunning-event", {
        name: "dunning/payment-failed",
        data: {
          workspace_id,
          subscription_id,
          customer_id: ctx.sub.customer_id,
          amount_cents: totalCents,
          braintree_transaction_id: charge.transactionId,
          processor_response_code: charge.processorResponseCode,
          processor_response_text: charge.processorResponseText,
          source: "internal_subscription_renewal",
        },
      });
      return { ok: false, failed: true, message: charge.message };
    }

    // ── 6. Create order + advance next_billing_date ─────────────
    const newOrder = await step.run("create-order", async () => {
      const { data: order, error } = await admin
        .from("orders")
        .insert({
          workspace_id,
          customer_id: ctx.sub.customer_id,
          shopify_customer_id: ctx.customer.shopify_customer_id || null,
          shopify_order_id: null,
          order_number: orderNumber,
          email: ctx.customer.email,
          total_cents: totalCents,
          currency: "USD",
          financial_status: "paid",
          fulfillment_status: null,
          line_items: items,
          source_name: "internal_subscription_renewal",
          shipping_address: ctx.shipping_address,
          billing_address: ctx.billing_address || ctx.shipping_address,
          braintree_transaction_id: charge.transactionId,
          braintree_payment_method_token: ctx.pm.braintree_payment_method_token,
          braintree_customer_id: ctx.pm.braintree_customer_id,
          subscription_id,
          payment_details: {
            subtotal_cents: subtotalCents,
            discount_cents: discountCents,
            shipping_cents: shippingCents,
            protection_cents: protectionCents,
            tax_cents: taxCents,
            gateway: "braintree",
            processor_response_code: charge.processorResponseCode,
            processor_response_text: charge.processorResponseText,
          },
          avalara_transaction_code: avalaraTransactionCode,
          avalara_total_tax_cents: avalaraTransactionCode ? taxCents : null,
          avalara_committed_at: avalaraTransactionCode ? new Date().toISOString() : null,
        })
        .select("id, order_number")
        .single();
      if (error || !order) throw new Error(`order_insert_failed: ${error?.message}`);
      // Backfill the transaction row with the order id.
      if (txnRowId) await admin.from("transactions").update({ order_id: order.id }).eq("id", txnRowId);
      return { id: order.id as string, order_number: order.order_number as string };
    });

    // Drop any one_time_next_renewal items now that they've shipped
    // on this renewal — they're spent. Recurring items stay.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const droppedAnyOneTime = ((ctx.sub.items as any[]) || []).some((i) => i?.one_time_next_renewal === true);
    // Advance next_billing_date by exactly `count` × `interval`.
    await step.run("advance-next-billing-date", async () => {
      const interval = (ctx.sub.billing_interval || "day").toLowerCase();
      const count = ctx.sub.billing_interval_count || 1;
      const current = ctx.sub.next_billing_date ? new Date(ctx.sub.next_billing_date) : new Date();
      const next = new Date(current);
      if (interval === "day") next.setUTCDate(next.getUTCDate() + count);
      else if (interval === "week") next.setUTCDate(next.getUTCDate() + count * 7);
      else if (interval === "month") next.setUTCMonth(next.getUTCMonth() + count);
      else if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + count);
      else next.setUTCDate(next.getUTCDate() + count * 28);
      // Filter out one-time items — they shipped on this renewal and
      // shouldn't recur.
      const update: Record<string, unknown> = {
        next_billing_date: next.toISOString(),
        // Persist consumed coupon cycles (decremented / auto-expired) — only
        // now, after a successful charge, so a failed charge doesn't burn one.
        applied_discounts: nextAppliedDiscounts,
        updated_at: new Date().toISOString(),
      };
      if (droppedAnyOneTime) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update.items = ((ctx.sub.items as any[]) || []).filter((i) => !i?.one_time_next_renewal);
      }
      await admin
        .from("subscriptions")
        .update(update)
        .eq("id", subscription_id);
    });

    // ── 7. Hand off to Amplifier for fulfillment ────────────────
    // Non-fatal: payment is already done; an Amplifier failure just
    // means manual fulfillment. amplifier_order_id gets backfilled to
    // the order on success so the rest of the dashboard works.
    await step.run("amplifier-order", async () => {
      type Item2 = { variant_id?: string; sku?: string; title?: string; variant_title?: string; quantity?: number; price_cents?: number };
      const lineItemsForAmplifier = items.map((l: Item2) => ({
        sku: (l.sku as string) || undefined,
        title: l.title,
        description: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title,
        quantity: l.quantity,
        unit_price_cents: l.price_cents,
        reference_id: l.variant_id ? String(l.variant_id) : undefined,
      }));
      const amplifierRes = await createAmplifierOrder({
        workspaceId: workspace_id,
        orderNumber: newOrder.order_number,
        orderDate: new Date().toISOString(),
        shippingAddress: ctx.shipping_address as Record<string, string> | null,
        billingAddress: ctx.billing_address as Record<string, string> | null,
        email: ctx.customer.email,
        phone: ctx.customer.phone || null,
        lineItems: lineItemsForAmplifier,
        totalCents,
        subtotalCents,
        shippingCents,
        taxCents,
      });
      if (amplifierRes.success && amplifierRes.amplifier_order_id) {
        await admin
          .from("orders")
          .update({
            amplifier_order_id: amplifierRes.amplifier_order_id,
            amplifier_received_at: new Date().toISOString(),
          })
          .eq("id", newOrder.id);
      } else {
        console.warn(`[renewal] Amplifier order create failed for ${newOrder.order_number}:`, amplifierRes.error, amplifierRes.details);
      }
    });

    return { ok: true, order_id: newOrder.id, order_number: newOrder.order_number };
  },
);
