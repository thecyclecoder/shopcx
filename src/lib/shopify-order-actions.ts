import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

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
): Promise<{ success: boolean; error?: string }> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const amountDecimal = (amountCents / 100).toFixed(2);

  try {
    // Step 1: Calculate refund to get parent transaction ID
    const calcRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/refunds/calculate.json`,
      {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ refund: { currency: "USD", shipping: { amount: 0 } } }),
      },
    );
    const calcData = await calcRes.json();
    const transactions = (calcData?.refund?.transactions || []) as { parent_id: number; kind: string }[];
    const parentTx = transactions.find(t => t.kind === "suggested_refund");
    if (!parentTx) return { success: false, error: "No refundable transaction found" };

    // Step 2: Issue the partial refund
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
            transactions: [{ parent_id: parentTx.parent_id, amount: amountDecimal, kind: "refund" }],
          },
        }),
      },
    );
    const refundData = await refundRes.json();
    if (refundData?.refund?.id) {
      return { success: true };
    }
    return { success: false, error: JSON.stringify(refundData?.errors || "Unknown refund error") };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
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
