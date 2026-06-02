import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { refundBraintreeTransaction } from "@/lib/integrations/braintree";

// ── Shopify GraphQL with variables support ──

async function shopifyMutation(
  workspaceId: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data;
}

function toGid(numericId: string, type: string): string {
  if (numericId.startsWith("gid://")) return numericId;
  return `gid://shopify/${type}/${numericId}`;
}

// ── Refund Order ──

export async function refundOrder(
  workspaceId: string,
  shopifyOrderId: string,
  options: {
    full?: boolean;
    lineItems?: { lineItemId: string; quantity: number }[];
    reason?: string;
    notify?: boolean;
  }
): Promise<{ success: boolean; error?: string }> {
  const orderId = toGid(shopifyOrderId, "Order");

  try {
    if (options.full) {
      // Use suggestedRefund to calculate the full refund amounts
      const suggestQuery = `
        query suggestedRefund($id: ID!) {
          order(id: $id) {
            suggestedRefund(suggestFullRefund: true) {
              refundLineItems {
                lineItem { id }
                quantity
              }
              shipping { maximumRefundableSet { shopMoney { amount currencyCode } } }
              subtotalSet { shopMoney { amount currencyCode } }
              totalCartDiscountAmountSet { shopMoney { amount currencyCode } }
            }
          }
        }
      `;
      const suggestData = await shopifyMutation(workspaceId, suggestQuery, { id: orderId });
      const order = suggestData.order as Record<string, unknown> | null;
      if (!order?.suggestedRefund) {
        return { success: false, error: "Could not calculate refund" };
      }
      const suggested = order.suggestedRefund as Record<string, unknown>;
      const refundLineItems = (suggested.refundLineItems as { lineItem: { id: string }; quantity: number }[]).map(
        (rli) => ({ lineItemId: rli.lineItem.id, quantity: rli.quantity })
      );
      const shipping = suggested.shipping as { maximumRefundableSet: { shopMoney: { amount: string } } } | null;
      const shippingAmount = shipping?.maximumRefundableSet?.shopMoney?.amount
        ? parseFloat(shipping.maximumRefundableSet.shopMoney.amount)
        : 0;

      const mutation = `
        mutation refundCreate($input: RefundInput!) {
          refundCreate(input: $input) {
            refund { id }
            userErrors { field message }
          }
        }
      `;
      const input: Record<string, unknown> = {
        orderId,
        notify: options.notify ?? true,
        note: options.reason || "Full refund",
        refundLineItems: refundLineItems.map((li) => ({
          lineItemId: li.lineItemId,
          quantity: li.quantity,
        })),
        shipping: { fullRefund: true },
      };

      // Only include shipping amount if > 0
      if (shippingAmount > 0) {
        input.shipping = { fullRefund: true };
      }

      const data = await shopifyMutation(workspaceId, mutation, { input });
      const result = data.refundCreate as { refund: { id: string } | null; userErrors: { field: string; message: string }[] };
      if (result.userErrors?.length) {
        return { success: false, error: result.userErrors.map((e) => e.message).join(", ") };
      }
      return { success: true };
    } else if (options.lineItems?.length) {
      // Partial refund by line items
      const mutation = `
        mutation refundCreate($input: RefundInput!) {
          refundCreate(input: $input) {
            refund { id }
            userErrors { field message }
          }
        }
      `;
      const input = {
        orderId,
        notify: options.notify ?? true,
        note: options.reason || "Partial refund",
        refundLineItems: options.lineItems.map((li) => ({
          lineItemId: toGid(li.lineItemId, "LineItem"),
          quantity: li.quantity,
        })),
      };

      const data = await shopifyMutation(workspaceId, mutation, { input });
      const result = data.refundCreate as { refund: { id: string } | null; userErrors: { field: string; message: string }[] };
      if (result.userErrors?.length) {
        return { success: false, error: result.userErrors.map((e) => e.message).join(", ") };
      }
      return { success: true };
    }

    return { success: false, error: "Must specify full refund or line items" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ── Partial Refund by Amount ──

export async function partialRefundByAmount(
  workspaceId: string,
  shopifyOrderId: string,
  amountCents: number,
  reason?: string,
): Promise<{ success: boolean; error?: string; method?: "shopify" | "braintree"; braintreeRefundId?: string; needsManualShopifyRecord?: boolean }> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const amountDecimal = (amountCents / 100).toFixed(2);

  // Defensive: if caller passed an order_number ("SC129695") instead of
  // the numeric shopify_order_id, resolve it. Opus has done this before
  // (Bryan Daguiar 2026-05-05) — the model grabs the human-readable
  // order # from the customer's message instead of the underlying ID,
  // and the REST endpoint silently returns no transactions for "SC###".
  if (!/^\d+$/.test(shopifyOrderId)) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data: order } = await admin.from("orders")
      .select("shopify_order_id")
      .eq("workspace_id", workspaceId)
      .eq("order_number", shopifyOrderId)
      .maybeSingle();
    if (!order?.shopify_order_id) {
      return { success: false, error: `Could not resolve order: "${shopifyOrderId}" (not a numeric Shopify ID, and no matching order_number found in workspace)` };
    }
    shopifyOrderId = order.shopify_order_id as string;
  }

  try {
    // Step 1: Get order transactions to find the gateway
    const txRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/transactions.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } },
    );
    const txData = await txRes.json();
    const saleTx = (txData?.transactions || []).find((t: { kind: string; status: string }) =>
      t.kind === "sale" && t.status === "success"
    ) || (txData?.transactions || [])[0];
    if (!saleTx) return { success: false, error: "No transaction found on order" };

    // Braintree orders can't be refunded through Shopify — the Shopify↔Braintree
    // gateway connection is gone, so Shopify's refund POST creates a refund record
    // whose inner transaction FAILS ("undefined method 'refund' for nil" /
    // ID_NOT_FOUND) while still returning a refund.id. We previously read that
    // refund.id as success and reported a refund that never moved money (SC128233
    // — 4 phantom "refunds", customer never paid back). Route Braintree gateways
    // to the direct-Braintree path instead.
    if (String(saleTx.gateway).toLowerCase().includes("braintree")) {
      const r = await refundOrderViaBraintree(workspaceId, shopifyOrderId, amountCents, reason);
      return { success: r.success, error: r.error, method: "braintree", braintreeRefundId: r.braintreeRefundId, needsManualShopifyRecord: r.needsManualShopifyRecord };
    }

    // Step 2: Issue the partial refund with gateway from original transaction
    const refundRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/refunds.json`,
      {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          refund: {
            currency: "USD",
            notify: false,
            note: reason || "Price adjustment",
            transactions: [{
              parent_id: saleTx.id,
              amount: amountDecimal,
              kind: "refund",
              gateway: saleTx.gateway,
            }],
          },
        }),
      },
    );
    const refundData = await refundRes.json();
    // A refund.id alone is NOT success — verify the inner refund transaction
    // actually settled, or we'll repeat the SC128233 phantom-refund bug.
    const refundTx = (refundData?.refund?.transactions || [])[0];
    if (refundData?.refund?.id && refundTx?.status === "success") {
      return { success: true, method: "shopify" };
    }
    // "pending" on shopify_payments is the normal transient state — the
    // refund typically settles to "success" within 1–3 seconds. Re-poll
    // the order's transactions briefly before declaring failure. Without
    // this retry we've reported "money did not move" three times today
    // (Edward, Clanay, Marilyn) for refunds that actually did land.
    if (refundData?.refund?.id && refundTx?.status === "pending") {
      const refundTxId = refundTx.id;
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise(r => setTimeout(r, 1500));
        const recheck = await fetch(
          `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/transactions.json`,
          { headers: { "X-Shopify-Access-Token": accessToken } },
        );
        const recheckData = await recheck.json();
        const found = (recheckData?.transactions || []).find((t: { id: number; kind: string; status: string }) =>
          t.id === refundTxId && t.kind === "refund",
        );
        if (found?.status === "success") return { success: true, method: "shopify" };
        if (found?.status === "failure" || found?.status === "error") {
          return { success: false, error: `Shopify refund transaction failed after polling: ${found?.message || "no message"}` };
        }
      }
      // Timed out still in pending after ~6s — surface as soft-failure so the
      // caller can fall back to "team will confirm" language rather than
      // claim the refund is done. Most resolve within 3s; staying pending
      // past 6s is rare and usually signals a real gateway issue.
      return { success: false, error: `Refund created but still pending after 6s of polling — needs manual reconciliation.` };
    }
    if (refundData?.refund?.id && refundTx && refundTx.status !== "success") {
      return { success: false, error: `Shopify recorded the refund but the gateway transaction is "${refundTx.status}" (${refundTx.message || "no message"}) — money did not move.` };
    }
    return { success: false, error: JSON.stringify(refundData?.errors || "Unknown refund error") };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** Append a note line and add a tag to a Shopify order (REST PUT, non-destructive). */
async function appendOrderNoteAndTag(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
  noteLine: string,
  tag: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const getRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}.json?fields=id,note,tags`,
      { headers: { "X-Shopify-Access-Token": accessToken } },
    );
    const cur = (await getRes.json())?.order || {};
    const note = cur.note ? `${cur.note}\n${noteLine}` : noteLine;
    const tags = cur.tags ? `${cur.tags}, ${tag}` : tag;
    const putRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}.json`,
      {
        method: "PUT",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ order: { id: Number(shopifyOrderId), note, tags } }),
      },
    );
    if (!putRes.ok) return { success: false, error: `Shopify order update failed: ${putRes.status} ${await putRes.text()}` };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Record a refund on a Shopify order WITHOUT moving money a second time. For
 * refunds already issued out-of-band (e.g. directly via the Braintree API).
 *
 * Healthy gateways: posts a "manual" gateway refund transaction so the order
 * shows (partially) refunded. Braintree orders REJECT every refund transaction
 * (even gateway:"manual") with Braintree::AuthenticationError — the Shopify↔
 * Braintree connection is gone — so for those we fall back to documenting the
 * refund as an order note + tag and flip our own orders row's financial_status.
 * Either way the customer already has their money; this is bookkeeping.
 */
export async function recordManualRefund(
  workspaceId: string,
  shopifyOrderId: string,
  amountCents: number,
  note?: string,
): Promise<{ success: boolean; refundId?: string; recordedVia?: "transaction" | "note"; error?: string }> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const amountDecimal = (amountCents / 100).toFixed(2);

  if (!/^\d+$/.test(shopifyOrderId)) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data: order } = await admin.from("orders")
      .select("shopify_order_id")
      .eq("workspace_id", workspaceId)
      .eq("order_number", shopifyOrderId)
      .maybeSingle();
    if (!order?.shopify_order_id) {
      return { success: false, error: `Could not resolve order: "${shopifyOrderId}"` };
    }
    shopifyOrderId = order.shopify_order_id as string;
  }

  try {
    const txRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/transactions.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } },
    );
    const txData = await txRes.json();
    const saleTx = (txData?.transactions || []).find((t: { kind: string; status: string }) =>
      t.kind === "sale" && t.status === "success"
    ) || (txData?.transactions || [])[0];
    if (!saleTx) return { success: false, error: "No transaction found on order" };

    const noteText = note || "Manual refund (processed externally)";
    const isBraintree = String(saleTx.gateway).toLowerCase().includes("braintree");

    // Braintree orders can't take refund transactions at all — skip straight to
    // the note+tag record so we don't pile up phantom failed refund records.
    if (!isBraintree) {
      const refundRes = await fetch(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/refunds.json`,
        {
          method: "POST",
          headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            refund: {
              currency: "USD",
              notify: false,
              note: noteText,
              transactions: [{ parent_id: saleTx.id, amount: amountDecimal, kind: "refund", gateway: "manual" }],
            },
          }),
        },
      );
      const refundData = await refundRes.json();
      const refundTx = (refundData?.refund?.transactions || [])[0];
      if (refundData?.refund?.id && (!refundTx || refundTx.status === "success")) {
        return { success: true, refundId: String(refundData.refund.id), recordedVia: "transaction" };
      }
      // fall through to note+tag if the transaction record didn't take
    }

    // Note + tag fallback (and the only path for Braintree orders).
    const marked = await appendOrderNoteAndTag(shop, accessToken, shopifyOrderId, `Refund recorded: $${amountDecimal} — ${noteText}`, "manual-refund");
    if (!marked.success) return { success: false, error: marked.error };

    // Reflect in our own orders row so the dashboard/AI sees it.
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const admin = createAdminClient();
      await admin.from("orders")
        .update({ financial_status: "partially_refunded" })
        .eq("workspace_id", workspaceId)
        .eq("shopify_order_id", shopifyOrderId);
    } catch { /* non-fatal */ }

    return { success: true, recordedVia: "note" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Refund an order paid through Braintree by refunding the Braintree transaction
 * DIRECTLY (Shopify's native Braintree refund is broken — see partialRefundByAmount),
 * then recording a manual refund on the Shopify order so the order reflects it.
 *
 * Two-step, and the order matters: money first (Braintree), bookkeeping second
 * (Shopify). If the Braintree refund fails we never touch Shopify. If the
 * Braintree refund succeeds but the Shopify record fails, the customer still got
 * their money — we surface needsManualShopifyRecord so a human can reconcile.
 */
export async function refundOrderViaBraintree(
  workspaceId: string,
  shopifyOrderId: string,
  amountCents: number,
  reason?: string,
): Promise<{ success: boolean; braintreeRefundId?: string; shopifyRefundId?: string; needsManualShopifyRecord?: boolean; error?: string }> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  // Resolve order_number → numeric id if needed.
  if (!/^\d+$/.test(shopifyOrderId)) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data: order } = await admin.from("orders")
      .select("shopify_order_id")
      .eq("workspace_id", workspaceId)
      .eq("order_number", shopifyOrderId)
      .maybeSingle();
    if (!order?.shopify_order_id) return { success: false, error: `Could not resolve order: "${shopifyOrderId}"` };
    shopifyOrderId = order.shopify_order_id as string;
  }

  // Find the sale transaction → the Braintree transaction id lives in `authorization`.
  const txRes = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/transactions.json`,
    { headers: { "X-Shopify-Access-Token": accessToken } },
  );
  const txData = await txRes.json();
  const saleTx = (txData?.transactions || []).find((t: { kind: string; status: string }) =>
    t.kind === "sale" && t.status === "success"
  );
  if (!saleTx) return { success: false, error: "No successful sale transaction found on order" };

  let braintreeTxnId: string | null = saleTx.authorization || null;

  // Fallback: Appstle subscription renewal orders frequently have a
  // null `authorization` field — Shopify just doesn't expose the BT
  // id on those transaction rows. When that happens, search BT
  // directly by customer email + amount + processed_at to find the
  // matching transaction.
  if (!braintreeTxnId) {
    // Pull the order's email + processed_at — needed for the BT search.
    const orderRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}.json?fields=email,contact_email,processed_at`,
      { headers: { "X-Shopify-Access-Token": accessToken } },
    );
    const orderData = await orderRes.json();
    const email = orderData?.order?.email || orderData?.order?.contact_email;
    const processedAt = orderData?.order?.processed_at || saleTx.processed_at || saleTx.created_at;
    if (!email || !processedAt) {
      return { success: false, error: "Sale transaction has no Braintree authorization id, and order is missing email/processed_at for the BT search fallback" };
    }
    const { findBraintreeTransactionByMetadata } = await import("@/lib/integrations/braintree");
    const match = await findBraintreeTransactionByMetadata(workspaceId, {
      email: String(email).toLowerCase(),
      amountDecimal: String(saleTx.amount),
      processedAt: String(processedAt),
    });
    if (!match) {
      return { success: false, error: `Sale transaction has no Braintree authorization id, and no matching BT transaction found via search (email=${email}, amount=${saleTx.amount}, processed_at=${processedAt})` };
    }
    braintreeTxnId = match.id;
  }

  // 1) Refund the money in Braintree.
  const bt = await refundBraintreeTransaction(workspaceId, braintreeTxnId, amountCents);
  if (!bt.success) return { success: false, error: `Braintree refund failed: ${bt.error}` };

  // 2) Record it on the Shopify order (manual gateway — no second money movement).
  const note = `${reason || "Refund"} — refunded via Braintree (txn ${bt.refundId || braintreeTxnId})`;
  const rec = await recordManualRefund(workspaceId, shopifyOrderId, amountCents, note);
  if (!rec.success) {
    // Money already returned — don't fail the whole op, but flag for reconciliation.
    return { success: true, braintreeRefundId: bt.refundId, needsManualShopifyRecord: true, error: `Braintree refund succeeded but Shopify record failed: ${rec.error}` };
  }

  return { success: true, braintreeRefundId: bt.refundId, shopifyRefundId: rec.refundId };
}

// ── Cancel Order ──

export async function cancelOrder(
  workspaceId: string,
  shopifyOrderId: string,
  options: {
    reason: "CUSTOMER" | "FRAUD" | "INVENTORY" | "DECLINED" | "OTHER";
    refund?: boolean;
    restock?: boolean;
    notify?: boolean;
  }
): Promise<{ success: boolean; error?: string }> {
  const orderId = toGid(shopifyOrderId, "Order");

  try {
    const mutation = `
      mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean) {
        orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer) {
          orderCancelUserErrors { field message }
        }
      }
    `;
    const data = await shopifyMutation(workspaceId, mutation, {
      orderId,
      reason: options.reason,
      refund: options.refund ?? true,
      restock: options.restock ?? true,
      notifyCustomer: options.notify ?? true,
    });

    const result = data.orderCancel as { orderCancelUserErrors: { field: string; message: string }[] };
    if (result.orderCancelUserErrors?.length) {
      return { success: false, error: result.orderCancelUserErrors.map((e) => e.message).join(", ") };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ── Update Shipping Address ──

export async function updateShippingAddress(
  workspaceId: string,
  shopifyOrderId: string,
  address: {
    address1: string;
    address2?: string;
    city: string;
    province: string;
    zip: string;
    country: string;
  }
): Promise<{ success: boolean; error?: string }> {
  const orderId = toGid(shopifyOrderId, "Order");

  try {
    const mutation = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id }
          userErrors { field message }
        }
      }
    `;
    const data = await shopifyMutation(workspaceId, mutation, {
      input: {
        id: orderId,
        shippingAddress: {
          address1: address.address1,
          address2: address.address2 || "",
          city: address.city,
          provinceCode: address.province,
          zip: address.zip,
          countryCode: address.country,
        },
      },
    });

    const result = data.orderUpdate as { order: { id: string } | null; userErrors: { field: string; message: string }[] };
    if (result.userErrors?.length) {
      return { success: false, error: result.userErrors.map((e) => e.message).join(", ") };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
