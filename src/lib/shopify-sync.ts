import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

interface ShopifyCredentials {
  shop: string;
  accessToken: string;
}

export async function getShopifyCredentials(
  workspaceId: string
): Promise<ShopifyCredentials> {
  const admin = createAdminClient();
  const { data: workspace, error } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", workspaceId)
    .single();

  if (error || !workspace?.shopify_access_token_encrypted || !workspace?.shopify_myshopify_domain) {
    throw new Error("Shopify not connected for this workspace");
  }

  return {
    shop: workspace.shopify_myshopify_domain,
    accessToken: decrypt(workspace.shopify_access_token_encrypted),
  };
}

// ── GraphQL helpers ──

async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
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
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${json.errors[0].message}`);
  }
  return json.data;
}

// ── Bulk Operations ──

const CUSTOMERS_BULK_QUERY = `
  mutation {
    bulkOperationRunQuery(
      query: """
      {
        customers {
          edges {
            node {
              id
              email
              firstName
              lastName
              phone
              numberOfOrders
              amountSpent {
                amount
                currencyCode
              }
              tags
              productSubscriberStatus
              createdAt
              updatedAt
            }
          }
        }
      }
      """
    ) {
      bulkOperation {
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

const ORDERS_BULK_QUERY = `
  mutation {
    bulkOperationRunQuery(
      query: """
      {
        orders {
          edges {
            node {
              id
              name
              email
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              displayFinancialStatus
              displayFulfillmentStatus
              createdAt
              customer {
                id
              }
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    quantity
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                      }
                    }
                    sku
                  }
                }
              }
            }
          }
        }
      }
      """
    ) {
      bulkOperation {
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

const POLL_QUERY = `
  query {
    currentBulkOperation {
      id
      status
      errorCode
      objectCount
      url
    }
  }
`;

async function runBulkOperation(
  shop: string,
  accessToken: string,
  mutation: string
): Promise<string> {
  // Start the bulk operation
  const data = await shopifyGraphQL(shop, accessToken, mutation);
  const result = data.bulkOperationRunQuery as {
    bulkOperation: { id: string; status: string } | null;
    userErrors: { field: string; message: string }[];
  };

  if (result.userErrors?.length) {
    throw new Error(`Bulk operation error: ${result.userErrors[0].message}`);
  }

  if (!result.bulkOperation) {
    throw new Error("Failed to start bulk operation");
  }

  // Poll until complete
  let attempts = 0;
  const maxAttempts = 120; // 10 minutes at 5s intervals

  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    attempts++;

    const pollData = await shopifyGraphQL(shop, accessToken, POLL_QUERY);
    const op = pollData.currentBulkOperation as {
      id: string;
      status: string;
      errorCode: string | null;
      objectCount: string;
      url: string | null;
    } | null;

    if (!op) throw new Error("No bulk operation found");

    if (op.status === "COMPLETED") {
      if (!op.url) return ""; // No results (empty store)
      return op.url;
    }

    if (op.status === "FAILED") {
      throw new Error(`Bulk operation failed: ${op.errorCode}`);
    }

    if (op.status === "CANCELED" || op.status === "CANCELLED") {
      throw new Error("Bulk operation was cancelled");
    }

    // Still RUNNING or CREATED — keep polling
  }

  throw new Error("Bulk operation timed out after 10 minutes");
}

async function downloadBulkResults(url: string): Promise<string[]> {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download bulk results: ${res.status}`);
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean);
}

// ── Subscription status mapping ──

function mapSubscriptionStatus(
  shopifyStatus: string | null | undefined
): "active" | "paused" | "cancelled" | "never" {
  switch (shopifyStatus) {
    case "ACTIVE":
      return "active";
    case "PAUSED":
      return "paused";
    case "CANCELLED":
    case "EXPIRED":
    case "FAILED":
      return "cancelled";
    case "NEVER_SUBSCRIBED":
    default:
      return "never";
  }
}

function dollarsToCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

function extractShopifyId(gid: string): string {
  // "gid://shopify/Customer/12345" → "12345"
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

// ── Sync functions ──

export async function syncCustomers(workspaceId: string): Promise<number> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  const resultUrl = await runBulkOperation(shop, accessToken, CUSTOMERS_BULK_QUERY);
  const lines = await downloadBulkResults(resultUrl);

  let synced = 0;
  const batchSize = 50;
  const records: Record<string, unknown>[] = [];

  for (const line of lines) {
    const c = JSON.parse(line);

    // Bulk operation results: top-level objects have an `id` field with gid format
    // Skip any nested objects (line items etc) that have a `__parentId`
    if (c.__parentId) continue;
    if (!c.id || !c.id.includes("Customer")) continue;

    records.push({
      workspace_id: workspaceId,
      shopify_customer_id: extractShopifyId(c.id),
      email: (c.email || `no-email-${extractShopifyId(c.id)}@unknown.com`).toLowerCase(),
      first_name: c.firstName || null,
      last_name: c.lastName || null,
      phone: c.phone || null,
      total_orders: parseInt(c.numberOfOrders) || 0,
      ltv_cents: dollarsToCents(c.amountSpent?.amount),
      subscription_status: mapSubscriptionStatus(c.productSubscriberStatus),
      tags: c.tags || [],
      updated_at: new Date().toISOString(),
    });
  }

  // Batch upsert
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error } = await admin
      .from("customers")
      .upsert(batch, { onConflict: "workspace_id,shopify_customer_id" });

    if (!error) {
      synced += batch.length;
    } else {
      console.error("Customer upsert error:", error.message, "batch index:", i);
    }
  }

  return synced;
}

export async function syncOrders(workspaceId: string): Promise<number> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  const resultUrl = await runBulkOperation(shop, accessToken, ORDERS_BULK_QUERY);
  const lines = await downloadBulkResults(resultUrl);

  // First pass: collect orders and their line items
  // Bulk operations emit parent objects and child objects separately
  // Orders come first, then their line items with __parentId
  const orderMap = new Map<string, Record<string, unknown>>();
  const lineItemsMap = new Map<string, Record<string, unknown>[]>();

  for (const line of lines) {
    const obj = JSON.parse(line);

    if (obj.__parentId) {
      // This is a line item (child of an order)
      const parentId = obj.__parentId as string;
      if (!lineItemsMap.has(parentId)) {
        lineItemsMap.set(parentId, []);
      }
      lineItemsMap.get(parentId)!.push({
        title: obj.title,
        quantity: obj.quantity,
        price_cents: dollarsToCents(obj.originalUnitPriceSet?.shopMoney?.amount),
        sku: obj.sku || null,
      });
    } else if (obj.id?.includes("Order")) {
      orderMap.set(obj.id, obj);
    }
  }

  // Build a lookup of shopify_customer_id → our customer UUID
  const { data: customers } = await admin
    .from("customers")
    .select("id, shopify_customer_id, email")
    .eq("workspace_id", workspaceId);

  const customerByShopifyId = new Map<string, string>();
  const customerByEmail = new Map<string, string>();
  for (const c of customers || []) {
    if (c.shopify_customer_id) customerByShopifyId.set(c.shopify_customer_id, c.id);
    if (c.email) customerByEmail.set(c.email.toLowerCase(), c.id);
  }

  let synced = 0;
  const batchSize = 50;
  const records: Record<string, unknown>[] = [];

  for (const [gid, o] of orderMap) {
    const shopifyOrderId = extractShopifyId(gid);
    const orderEmail = ((o.email as string) || "").toLowerCase();
    const shopifyCustomerGid = (o.customer as { id?: string })?.id;
    const shopifyCustomerId = shopifyCustomerGid ? extractShopifyId(shopifyCustomerGid) : null;

    // Resolve customer
    let customerId: string | null = null;
    if (shopifyCustomerId) customerId = customerByShopifyId.get(shopifyCustomerId) || null;
    if (!customerId && orderEmail) customerId = customerByEmail.get(orderEmail) || null;

    records.push({
      workspace_id: workspaceId,
      shopify_order_id: shopifyOrderId,
      customer_id: customerId,
      order_number: (o.name as string) || null,
      email: orderEmail || null,
      total_cents: dollarsToCents((o.totalPriceSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount),
      currency: (o.totalPriceSet as { shopMoney?: { currencyCode?: string } })?.shopMoney?.currencyCode || "USD",
      financial_status: (o.displayFinancialStatus as string) || null,
      fulfillment_status: (o.displayFulfillmentStatus as string) || null,
      line_items: lineItemsMap.get(gid) || [],
      created_at: (o.createdAt as string) || new Date().toISOString(),
    });
  }

  // Batch upsert
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error } = await admin
      .from("orders")
      .upsert(batch, { onConflict: "workspace_id,shopify_order_id" });

    if (!error) {
      synced += batch.length;
    } else {
      console.error("Order upsert error:", error.message, "batch index:", i);
    }
  }

  // Update first_order_at and last_order_at on customers via SQL
  // This is much more efficient than looping through each customer
  try {
    await admin.rpc("update_customer_order_dates", { ws_id: workspaceId });
  } catch {
    console.warn("RPC update_customer_order_dates not available, skipping order date backfill");
  }

  return synced;
}
