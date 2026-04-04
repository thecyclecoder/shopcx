// Shopify Returns API integration — create returns, attach tracking, dispose items, process/close returns

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
    }
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
  reverseFulfillmentOrderGid: string;
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
  locationId?: string;
}

export interface ReturnableItem {
  fulfillmentLineItemId: string;
  quantity: number;
  title: string;
  amountCents: number;
  variantId?: string;
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
                  lineItem {
                    title
                    quantity
                  }
                }
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
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
      returnLineItems: params.returnLineItems.map(item => ({
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

  const returnCreate = result.data?.returnCreate as {
    return?: {
      id: string;
      status: string;
      reverseFulfillmentOrders?: {
        nodes: { id: string; status: string; lineItems: { nodes: { id: string; totalQuantity: number }[] } }[];
      };
    };
    userErrors?: { field: string; message: string }[];
  };

  if (returnCreate?.userErrors?.length) {
    throw new Error(`Shopify returnCreate userError: ${returnCreate.userErrors[0].message}`);
  }

  const shopifyReturn = returnCreate?.return;
  if (!shopifyReturn) {
    throw new Error("Shopify returnCreate returned no data");
  }

  const reverseFulfillmentOrderGid = shopifyReturn.reverseFulfillmentOrders?.nodes?.[0]?.id || "";

  // Calculate order total from returnable items
  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("total_cents")
    .eq("id", params.orderId)
    .single();

  // Insert into returns table
  const { data: returnRow, error: insertError } = await admin
    .from("returns")
    .insert({
      workspace_id: workspaceId,
      order_id: params.orderId,
      order_number: params.orderNumber,
      shopify_order_gid: params.shopifyOrderGid,
      customer_id: params.customerId,
      ticket_id: params.ticketId || null,
      shopify_return_gid: shopifyReturn.id,
      shopify_reverse_fulfillment_order_gid: reverseFulfillmentOrderGid,
      status: "open",
      resolution_type: params.resolutionType,
      source: params.source,
      order_total_cents: order?.total_cents || 0,
      return_line_items: params.returnLineItems.map(item => ({
        shopify_fulfillment_line_item_id: item.fulfillmentLineItemId,
        quantity: item.quantity,
        title: item.title,
      })),
    })
    .select("id")
    .single();

  if (insertError) {
    throw new Error(`Failed to insert return record: ${insertError.message}`);
  }

  return {
    returnId: returnRow!.id,
    shopifyReturnGid: shopifyReturn.id,
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
            tracking {
              number
              carrierName
            }
            label {
              publicFileUrl
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function attachReturnTracking(
  workspaceId: string,
  params: AttachTrackingParams,
): Promise<{ shopifyReverseDeliveryGid: string }> {
  const admin = createAdminClient();

  // Get the return record
  const { data: returnRow, error: fetchError } = await admin
    .from("returns")
    .select("shopify_reverse_fulfillment_order_gid")
    .eq("id", params.returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (fetchError || !returnRow?.shopify_reverse_fulfillment_order_gid) {
    throw new Error("Return not found or missing reverse fulfillment order GID");
  }

  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const variables: Record<string, unknown> = {
    reverseFulfillmentOrderId: returnRow.shopify_reverse_fulfillment_order_gid,
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
    throw new Error(`Shopify reverseDeliveryCreateWithShipping error: ${result.errors[0].message}`);
  }

  const deliveryResult = result.data?.reverseDeliveryCreateWithShipping as {
    reverseDelivery?: { id: string; status: string };
    userErrors?: { field: string; message: string }[];
  };

  if (deliveryResult?.userErrors?.length) {
    throw new Error(`Shopify reverseDelivery userError: ${deliveryResult.userErrors[0].message}`);
  }

  const reverseDeliveryGid = deliveryResult?.reverseDelivery?.id || "";

  // Update return record
  await admin
    .from("returns")
    .update({
      shopify_reverse_delivery_gid: reverseDeliveryGid,
      tracking_number: params.trackingNumber,
      carrier: params.carrier,
      label_url: params.labelUrl || null,
      status: "label_created",
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.returnId)
    .eq("workspace_id", workspaceId);

  return { shopifyReverseDeliveryGid: reverseDeliveryGid };
}

// ── 3. disposeReturnItems ──

const DISPOSE_MUTATION = `
  mutation DisposeItems($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
    reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
      reverseFulfillmentOrderLineItems {
        id
        dispositionType
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function disposeReturnItems(
  workspaceId: string,
  params: DisposeParams,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  // Get the return record with its reverse fulfillment order line items
  const { data: returnRow, error: fetchError } = await admin
    .from("returns")
    .select("shopify_reverse_fulfillment_order_gid, return_line_items, shopify_return_gid")
    .eq("id", params.returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (fetchError || !returnRow?.shopify_reverse_fulfillment_order_gid) {
    return { success: false, error: "Return not found or missing reverse fulfillment order GID" };
  }

  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  // Query the reverse fulfillment order to get its line item IDs
  const rfoQuery = `
    query ReverseFulfillmentOrder($id: ID!) {
      reverseFulfillmentOrder(id: $id) {
        lineItems(first: 50) {
          nodes {
            id
            totalQuantity
          }
        }
      }
    }
  `;

  const rfoResult = await shopifyGraphQL(shop, accessToken, rfoQuery, {
    id: returnRow.shopify_reverse_fulfillment_order_gid,
  });

  const rfo = rfoResult.data?.reverseFulfillmentOrder as {
    lineItems?: { nodes: { id: string; totalQuantity: number }[] };
  };

  const lineItems = rfo?.lineItems?.nodes || [];
  if (lineItems.length === 0) {
    return { success: false, error: "No line items found on reverse fulfillment order" };
  }

  // Build disposition inputs
  const dispositionInputs = lineItems.map(item => ({
    reverseFulfillmentOrderLineItemId: item.id,
    quantity: item.totalQuantity,
    dispositionType: params.disposition,
    ...(params.disposition === "RESTOCKED" && params.locationId && { locationId: params.locationId }),
  }));

  const result = await shopifyGraphQL(shop, accessToken, DISPOSE_MUTATION, {
    dispositionInputs,
  });

  if (result.errors?.length) {
    return { success: false, error: result.errors[0].message };
  }

  const disposeResult = result.data?.reverseFulfillmentOrderDispose as {
    userErrors?: { field: string; message: string }[];
  };

  if (disposeResult?.userErrors?.length) {
    return { success: false, error: disposeResult.userErrors[0].message };
  }

  // Update return status
  await admin
    .from("returns")
    .update({
      status: "restocked",
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.returnId)
    .eq("workspace_id", workspaceId);

  return { success: true };
}

// ── 4. processReturn (all-in-one: dispose + refund + close) ──

const RETURN_PROCESS_MUTATION = `
  mutation ReturnProcess($input: ReturnProcessInput!) {
    returnProcess(returnProcessInput: $input) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function processReturn(
  workspaceId: string,
  returnId: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: returnRow, error: fetchError } = await admin
    .from("returns")
    .select("shopify_return_gid")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (fetchError || !returnRow?.shopify_return_gid) {
    return { success: false, error: "Return not found or missing Shopify return GID" };
  }

  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  // First query the Shopify return to get its line item IDs
  const returnQuery = `
    query ReturnDetail($id: ID!) {
      node(id: $id) {
        ... on Return {
          returnLineItems(first: 50) {
            nodes {
              id
              quantity
            }
          }
        }
      }
    }
  `;

  const queryResult = await shopifyGraphQL(shop, accessToken, returnQuery, {
    id: returnRow.shopify_return_gid,
  });

  const returnNode = queryResult.data?.node as {
    returnLineItems?: { nodes: { id: string; quantity: number }[] };
  };

  const returnLineItems = returnNode?.returnLineItems?.nodes || [];
  if (returnLineItems.length === 0) {
    return { success: false, error: "No return line items found" };
  }

  const result = await shopifyGraphQL(shop, accessToken, RETURN_PROCESS_MUTATION, {
    input: {
      returnId: returnRow.shopify_return_gid,
      returnLineItems: returnLineItems.map(item => ({
        id: item.id,
        quantity: item.quantity,
      })),
    },
  });

  if (result.errors?.length) {
    return { success: false, error: result.errors[0].message };
  }

  const processResult = result.data?.returnProcess as {
    return?: { id: string; status: string };
    userErrors?: { field: string; message: string }[];
  };

  if (processResult?.userErrors?.length) {
    return { success: false, error: processResult.userErrors[0].message };
  }

  // Update return status
  await admin
    .from("returns")
    .update({
      status: "closed",
      processed_at: new Date().toISOString(),
      refunded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", returnId)
    .eq("workspace_id", workspaceId);

  return { success: true };
}

// ── 5. closeReturn ──

const RETURN_CLOSE_MUTATION = `
  mutation ReturnClose($id: ID!) {
    returnClose(id: $id) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function closeReturn(
  workspaceId: string,
  returnId: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: returnRow, error: fetchError } = await admin
    .from("returns")
    .select("shopify_return_gid")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (fetchError || !returnRow?.shopify_return_gid) {
    return { success: false, error: "Return not found or missing Shopify return GID" };
  }

  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const result = await shopifyGraphQL(shop, accessToken, RETURN_CLOSE_MUTATION, {
    id: returnRow.shopify_return_gid,
  });

  if (result.errors?.length) {
    return { success: false, error: result.errors[0].message };
  }

  const closeResult = result.data?.returnClose as {
    userErrors?: { field: string; message: string }[];
  };

  if (closeResult?.userErrors?.length) {
    return { success: false, error: closeResult.userErrors[0].message };
  }

  await admin
    .from("returns")
    .update({
      status: "closed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", returnId)
    .eq("workspace_id", workspaceId);

  return { success: true };
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
                weight
                weightUnit
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
              fulfillmentLineItem { id }
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
    fulfillments?: {
      id: string;
      status: string;
      fulfillmentLineItems: {
        nodes: {
          id: string;
          originalTotalSet: { shopMoney: { amount: string; currencyCode: string } };
          quantity: number;
          lineItem: { title: string; variant?: { id: string; weight: number; weightUnit: string } };
        }[];
      };
    }[];
    returns?: {
      nodes: {
        id: string;
        status: string;
        returnLineItems: {
          nodes: { fulfillmentLineItem: { id: string }; quantity: number }[];
        };
      }[];
    };
  };

  if (!order) {
    throw new Error("Order not found in Shopify");
  }

  // Build map of already-returned quantities per fulfillment line item
  const returnedQuantities = new Map<string, number>();
  const existingReturns = order.returns?.nodes || [];
  for (const ret of existingReturns) {
    // Skip cancelled returns
    if (ret.status === "CANCELED") continue;
    for (const rli of ret.returnLineItems.nodes) {
      const existing = returnedQuantities.get(rli.fulfillmentLineItem.id) || 0;
      returnedQuantities.set(rli.fulfillmentLineItem.id, existing + rli.quantity);
    }
  }

  // Collect returnable items from fulfilled orders
  const items: ReturnableItem[] = [];
  const fulfillments = order.fulfillments || [];

  for (const fulfillment of fulfillments) {
    // Only fulfilled items can be returned
    if (fulfillment.status !== "SUCCESS") continue;

    for (const fli of fulfillment.fulfillmentLineItems.nodes) {
      const alreadyReturned = returnedQuantities.get(fli.id) || 0;
      const remainingQuantity = fli.quantity - alreadyReturned;

      if (remainingQuantity > 0) {
        const amountCents = Math.round(parseFloat(fli.originalTotalSet.shopMoney.amount) * 100);
        items.push({
          fulfillmentLineItemId: fli.id,
          quantity: remainingQuantity,
          title: fli.lineItem.title,
          amountCents,
          variantId: fli.lineItem.variant?.id,
        });
      }
    }
  }

  return items;
}
