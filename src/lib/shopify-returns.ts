// Shopify Returns API — create returns, attach tracking, dispose items, process, close

import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { createAdminClient } from "@/lib/supabase/admin";

// ── GraphQL helper ──

async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
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

// ── Types ──

export interface CreateReturnParams {
  orderId: string;          // Our internal order UUID
  orderNumber: string;      // SC126222
  shopifyOrderGid: string;  // gid://shopify/Order/123
  customerId: string;
  ticketId?: string;
  resolutionType: "store_credit_return" | "refund_return" | "store_credit_no_return" | "refund_no_return";
  returnLineItems: { fulfillmentLineItemId: string; quantity: number; title: string }[];
  source: "playbook" | "agent" | "portal";
}

export interface CreateReturnResult {
  returnId: string;
  shopifyReturnGid: string;
  reverseFulfillmentOrderGid: string | null;
}

export interface AttachTrackingParams {
  returnId: string;
  trackingNumber: string;
  trackingUrl?: string;
  carrier: string;
  labelUrl?: string;
}

export type Disposition = "RESTOCKED" | "MISSING" | "PROCESSING_REQUIRED" | "NOT_RESTOCKED";

export interface DisposeParams {
  returnId: string;
  disposition: Disposition;
  locationId?: string; // Required for RESTOCKED
}

export interface ReturnableItem {
  fulfillmentLineItemId: string;
  title: string;
  quantity: number;
  remainingQuantity: number;
  amountCents: number;
  currencyCode: string;
  variantId: string | null;
}

// ── 1. createShopifyReturn ──

const RETURN_CREATE_MUTATION = `
  mutation ReturnCreate($input: ReturnInput!) {
    returnCreate(returnInput: $input) {
      return {
        id
        status
        reverseFulfillmentOrders(first: 1) {
          nodes {
            id
            status
            lineItems(first: 50) {
              nodes {
                id
                totalQuantity
                fulfillmentLineItem {
                  id
                  lineItem { title quantity }
                }
              }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

export async function createShopifyReturn(
  workspaceId: string,
  params: CreateReturnParams,
): Promise<CreateReturnResult> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const result = await shopifyGraphQL(shop, accessToken, RETURN_CREATE_MUTATION, {
    input: {
      orderId: params.shopifyOrderGid,
      returnLineItems: params.returnLineItems.map((item) => ({
        fulfillmentLineItemId: item.fulfillmentLineItemId,
        quantity: item.quantity,
        returnReason: "UNWANTED",
        returnReasonNote: `Return initiated via ${params.source}`,
      })),
      notifyCustomer: false,
    },
  });

  if (result.errors?.length) {
    throw new Error(`Shopify returnCreate error: ${result.errors[0].message}`);
  }

  const data = result.data?.returnCreate as {
    return: {
      id: string;
      status: string;
      reverseFulfillmentOrders: { nodes: { id: string; lineItems: { nodes: { id: string; totalQuantity: number; fulfillmentLineItem: { id: string } }[] } }[] };
    } | null;
    userErrors: { field: string; message: string }[];
  };

  if (data.userErrors?.length) {
    throw new Error(`Shopify returnCreate user error: ${data.userErrors[0].message}`);
  }

  if (!data.return) {
    throw new Error("Shopify returnCreate returned null");
  }

  const shopifyReturnGid = data.return.id;
  const rfo = data.return.reverseFulfillmentOrders.nodes[0];
  const reverseFulfillmentOrderGid = rfo?.id || null;

  // Store return_line_items with reverse fulfillment order line item IDs for later disposal
  const returnLineItemsWithRfoIds = params.returnLineItems.map((item) => {
    const rfoLineItem = rfo?.lineItems.nodes.find(
      (n) => n.fulfillmentLineItem.id === item.fulfillmentLineItemId,
    );
    return {
      shopify_fulfillment_line_item_id: item.fulfillmentLineItemId,
      shopify_rfo_line_item_id: rfoLineItem?.id || null,
      quantity: item.quantity,
      title: item.title,
    };
  });

  // Insert into our DB
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("returns")
    .insert({
      workspace_id: workspaceId,
      order_id: params.orderId,
      order_number: params.orderNumber,
      shopify_order_gid: params.shopifyOrderGid,
      customer_id: params.customerId,
      ticket_id: params.ticketId || null,
      shopify_return_gid: shopifyReturnGid,
      shopify_reverse_fulfillment_order_gid: reverseFulfillmentOrderGid,
      status: "open",
      resolution_type: params.resolutionType,
      source: params.source,
      return_line_items: returnLineItemsWithRfoIds,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to insert return: ${error.message}`);
  }

  return {
    returnId: row.id,
    shopifyReturnGid,
    reverseFulfillmentOrderGid,
  };
}

// ── 2. attachReturnTracking ──

const REVERSE_DELIVERY_CREATE_MUTATION = `
  mutation ReverseDeliveryCreate(
    $reverseFulfillmentOrderId: ID!,
    $trackingInput: ReverseDeliveryTrackingInput,
    $labelInput: ReverseDeliveryLabelInput
  ) {
    reverseDeliveryCreateWithShipping(
      reverseFulfillmentOrderId: $reverseFulfillmentOrderId
      trackingInput: $trackingInput
      labelInput: $labelInput
      notifyCustomer: false
    ) {
      reverseDelivery {
        id
        status
        deliverable {
          ... on ReverseDeliveryShippingDeliverable {
            tracking { number carrierName }
            label { publicFileUrl }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

export async function attachReturnTracking(
  workspaceId: string,
  params: AttachTrackingParams,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  // Get the return record
  const { data: ret } = await admin
    .from("returns")
    .select("shopify_reverse_fulfillment_order_gid")
    .eq("id", params.returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret?.shopify_reverse_fulfillment_order_gid) {
    return { success: false, error: "Return has no reverse fulfillment order" };
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const variables: Record<string, unknown> = {
      reverseFulfillmentOrderId: ret.shopify_reverse_fulfillment_order_gid,
      trackingInput: {
        number: params.trackingNumber,
        ...(params.trackingUrl && { url: params.trackingUrl }),
      },
    };

    if (params.labelUrl) {
      variables.labelInput = { fileUrl: params.labelUrl };
    }

    const result = await shopifyGraphQL(shop, accessToken, REVERSE_DELIVERY_CREATE_MUTATION, variables);

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const data = result.data?.reverseDeliveryCreateWithShipping as {
      reverseDelivery: { id: string } | null;
      userErrors: { message: string }[];
    };

    if (data.userErrors?.length) {
      return { success: false, error: data.userErrors[0].message };
    }

    // Update our DB
    await admin
      .from("returns")
      .update({
        shopify_reverse_delivery_gid: data.reverseDelivery?.id || null,
        tracking_number: params.trackingNumber,
        carrier: params.carrier,
        label_url: params.labelUrl || null,
        status: "label_created",
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.returnId);

    return { success: true };
  } catch (err) {
    console.error(`Failed to attach return tracking for ${params.returnId}:`, err);
    return { success: false, error: String(err) };
  }
}

// ── 3. disposeReturnItems ──

const DISPOSE_MUTATION = `
  mutation DisposeItems($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
    reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
      reverseFulfillmentOrderLineItems {
        id
        dispositionType
      }
      userErrors { field message }
    }
  }
`;

export async function disposeReturnItems(
  workspaceId: string,
  params: DisposeParams,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: ret } = await admin
    .from("returns")
    .select("return_line_items, shopify_reverse_fulfillment_order_gid")
    .eq("id", params.returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret) {
    return { success: false, error: "Return not found" };
  }

  const lineItems = ret.return_line_items as {
    shopify_rfo_line_item_id: string | null;
    quantity: number;
  }[];

  const dispositionInputs = lineItems
    .filter((item) => item.shopify_rfo_line_item_id)
    .map((item) => ({
      reverseFulfillmentOrderLineItemId: item.shopify_rfo_line_item_id,
      quantity: item.quantity,
      dispositionType: params.disposition,
      ...(params.disposition === "RESTOCKED" && params.locationId && { locationId: params.locationId }),
    }));

  if (dispositionInputs.length === 0) {
    return { success: false, error: "No line items with reverse fulfillment order IDs to dispose" };
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const result = await shopifyGraphQL(shop, accessToken, DISPOSE_MUTATION, { dispositionInputs });

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const data = result.data?.reverseFulfillmentOrderDispose as {
      userErrors: { message: string }[];
    };

    if (data.userErrors?.length) {
      return { success: false, error: data.userErrors[0].message };
    }

    await admin
      .from("returns")
      .update({
        status: "restocked",
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.returnId);

    return { success: true };
  } catch (err) {
    console.error(`Failed to dispose return items for ${params.returnId}:`, err);
    return { success: false, error: String(err) };
  }
}

// ── 4. processReturn (all-in-one: dispose + refund + close) ──

const RETURN_PROCESS_MUTATION = `
  mutation ReturnProcess($input: ReturnProcessInput!) {
    returnProcess(returnProcessInput: $input) {
      return { id status }
      userErrors { field message }
    }
  }
`;

export async function processReturn(
  workspaceId: string,
  returnId: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: ret } = await admin
    .from("returns")
    .select("shopify_return_gid, return_line_items")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret?.shopify_return_gid) {
    return { success: false, error: "Return not found or missing Shopify GID" };
  }

  // We need Shopify ReturnLineItem IDs for processReturn — query them
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    // First, fetch the return's line items from Shopify
    const queryResult = await shopifyGraphQL(shop, accessToken, `
      query ReturnLineItems($id: ID!) {
        return(id: $id) {
          returnLineItems(first: 50) {
            nodes { id quantity }
          }
        }
      }
    `, { id: ret.shopify_return_gid });

    const returnData = (queryResult.data?.return as { returnLineItems: { nodes: { id: string; quantity: number }[] } }) || null;
    if (!returnData?.returnLineItems?.nodes?.length) {
      return { success: false, error: "No return line items found in Shopify" };
    }

    const result = await shopifyGraphQL(shop, accessToken, RETURN_PROCESS_MUTATION, {
      input: {
        returnId: ret.shopify_return_gid,
        returnLineItems: returnData.returnLineItems.nodes.map((n) => ({
          id: n.id,
          quantity: n.quantity,
        })),
      },
    });

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const data = result.data?.returnProcess as {
      userErrors: { message: string }[];
    };

    if (data.userErrors?.length) {
      return { success: false, error: data.userErrors[0].message };
    }

    await admin
      .from("returns")
      .update({
        status: "closed",
        processed_at: new Date().toISOString(),
        refunded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", returnId);

    return { success: true };
  } catch (err) {
    console.error(`Failed to process return ${returnId}:`, err);
    return { success: false, error: String(err) };
  }
}

// ── 5. closeReturn ──

const RETURN_CLOSE_MUTATION = `
  mutation ReturnClose($id: ID!) {
    returnClose(id: $id) {
      return { id status }
      userErrors { field message }
    }
  }
`;

export async function closeReturn(
  workspaceId: string,
  returnId: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: ret } = await admin
    .from("returns")
    .select("shopify_return_gid")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret?.shopify_return_gid) {
    return { success: false, error: "Return not found or missing Shopify GID" };
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const result = await shopifyGraphQL(shop, accessToken, RETURN_CLOSE_MUTATION, {
      id: ret.shopify_return_gid,
    });

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const data = result.data?.returnClose as {
      userErrors: { message: string }[];
    };

    if (data.userErrors?.length) {
      return { success: false, error: data.userErrors[0].message };
    }

    await admin
      .from("returns")
      .update({
        status: "closed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", returnId);

    return { success: true };
  } catch (err) {
    console.error(`Failed to close return ${returnId}:`, err);
    return { success: false, error: String(err) };
  }
}

// ── 6. getReturnableItems ──

const ORDER_RETURNABLE_QUERY = `
  query OrderReturnable($id: ID!) {
    order(id: $id) {
      id
      name
      fulfillments {
        id
        status
        fulfillmentLineItems(first: 50) {
          nodes {
            id
            originalTotalSet {
              shopMoney { amount currencyCode }
            }
            quantity
            lineItem {
              title
              variant {
                id
              }
            }
          }
        }
      }
      returns(first: 10) {
        nodes {
          id
          status
          returnLineItems(first: 50) {
            nodes {
              id
              quantity
            }
          }
        }
      }
    }
  }
`;

export async function getReturnableItems(
  workspaceId: string,
  shopifyOrderGid: string,
): Promise<ReturnableItem[]> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const result = await shopifyGraphQL(shop, accessToken, ORDER_RETURNABLE_QUERY, {
    id: shopifyOrderGid,
  });

  if (result.errors?.length) {
    throw new Error(`Shopify order query error: ${result.errors[0].message}`);
  }

  const order = result.data?.order as {
    fulfillments: {
      id: string;
      status: string;
      fulfillmentLineItems: {
        nodes: {
          id: string;
          originalTotalSet: { shopMoney: { amount: string; currencyCode: string } };
          quantity: number;
          lineItem: {
            title: string;
            variant: { id: string } | null;
          };
        }[];
      };
    }[];
    returns: {
      nodes: {
        id: string;
        status: string;
        returnLineItems: {
          nodes: {
            id: string;
            quantity: number;
          }[];
        };
      }[];
    };
  } | null;

  if (!order) {
    throw new Error("Order not found in Shopify");
  }

  // Build count of already-returned items (exclude CANCELED returns)
  let totalReturnedQuantity = 0;
  for (const ret of order.returns.nodes) {
    if (ret.status === "CANCELED") continue;
    for (const item of ret.returnLineItems.nodes) {
      totalReturnedQuantity += item.quantity;
    }
  }

  // Collect returnable items from fulfilled orders
  const items: ReturnableItem[] = [];
  for (const fulfillment of order.fulfillments) {
    if (fulfillment.status !== "SUCCESS") continue;

    for (const fli of fulfillment.fulfillmentLineItems.nodes) {
      const alreadyReturned = totalReturnedQuantity; // Simplified: if any returns exist, reduce remaining
      const remaining = fli.quantity - alreadyReturned;
      if (remaining <= 0) continue;

      const amountCents = Math.round(parseFloat(fli.originalTotalSet.shopMoney.amount) * 100);

      items.push({
        fulfillmentLineItemId: fli.id,
        title: fli.lineItem.title,
        quantity: fli.quantity,
        remainingQuantity: remaining,
        amountCents,
        currencyCode: fli.originalTotalSet.shopMoney.currencyCode,
        variantId: fli.lineItem.variant?.id || null,
      });
    }
  }

  return items;
}
