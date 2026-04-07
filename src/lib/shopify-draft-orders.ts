// Shopify Draft Order creation for replacement orders
// Creates $0 draft orders using 100% discount, then completes them

import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

export interface ReplacementLineItem {
  variantId: string; // Shopify variant ID (numeric, not GID)
  title: string;
  quantity: number;
}

export interface ReplacementOrderInput {
  lineItems: ReplacementLineItem[];
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    province: string; // state code
    zip: string;
    country: string;
    phone?: string;
  };
  customerEmail: string;
  originalOrderNumber: string;
  reason: string;
  note?: string;
}

export interface CreatedDraftOrder {
  draftOrderId: string; // GID
  draftOrderName: string;
}

export interface CompletedReplacementOrder {
  draftOrderId: string;
  orderId: string; // GID
  orderName: string; // e.g. "SC126001"
  shopifyOrderId: string; // numeric
}

async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * Create a $0 draft order for replacement items.
 * Uses 100% discount so no coupon codes are needed.
 */
export async function createReplacementDraftOrder(
  workspaceId: string,
  input: ReplacementOrderInput,
): Promise<CreatedDraftOrder> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const note = input.note || `Replacement for ${input.originalOrderNumber} — ${input.reason}`;

  const variables = {
    input: {
      lineItems: input.lineItems.map((item) => ({
        variantId: `gid://shopify/ProductVariant/${item.variantId}`,
        quantity: item.quantity,
      })),
      appliedDiscount: {
        title: `Replacement — ${input.reason}`,
        valueType: "PERCENTAGE",
        value: 100,
      },
      shippingAddress: {
        firstName: input.shippingAddress.firstName,
        lastName: input.shippingAddress.lastName,
        address1: input.shippingAddress.address1,
        address2: input.shippingAddress.address2 || undefined,
        city: input.shippingAddress.city,
        provinceCode: input.shippingAddress.province,
        zip: input.shippingAddress.zip,
        countryCode: input.shippingAddress.country,
        phone: input.shippingAddress.phone || undefined,
      },
      email: input.customerEmail,
      note,
      tags: ["replacement", `replacement:${input.originalOrderNumber}`],
      shippingLine: {
        title: "Economy",
        price: "0.00",
      },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await shopifyGraphQL(shop, accessToken, mutation, variables)) as any;
  const data = result.data?.draftOrderCreate;

  if (data?.userErrors?.length) {
    throw new Error(`Draft order creation failed: ${data.userErrors.map((e: { message: string }) => e.message).join(", ")}`);
  }

  if (!data?.draftOrder?.id) {
    throw new Error("Draft order creation returned no data");
  }

  return {
    draftOrderId: data.draftOrder.id,
    draftOrderName: data.draftOrder.name,
  };
}

/**
 * Complete a draft order — converts it to a real order.
 */
export async function completeDraftOrder(
  workspaceId: string,
  draftOrderId: string,
): Promise<CompletedReplacementOrder> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const mutation = `
    mutation draftOrderComplete($id: ID!) {
      draftOrderComplete(id: $id) {
        draftOrder {
          id
          order {
            id
            name
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await shopifyGraphQL(shop, accessToken, mutation, { id: draftOrderId })) as any;
  const data = result.data?.draftOrderComplete;

  if (data?.userErrors?.length) {
    throw new Error(`Draft order completion failed: ${data.userErrors.map((e: { message: string }) => e.message).join(", ")}`);
  }

  const order = data?.draftOrder?.order;
  if (!order?.id) {
    throw new Error("Draft order completion returned no order");
  }

  // Extract numeric ID from GID
  const shopifyOrderId = order.id.replace("gid://shopify/Order/", "");

  return {
    draftOrderId,
    orderId: order.id,
    orderName: order.name,
    shopifyOrderId,
  };
}

/**
 * Full flow: create draft + complete → returns the replacement order.
 */
export async function createAndCompleteReplacement(
  workspaceId: string,
  input: ReplacementOrderInput,
): Promise<CompletedReplacementOrder> {
  const draft = await createReplacementDraftOrder(workspaceId, input);
  return completeDraftOrder(workspaceId, draft.draftOrderId);
}
