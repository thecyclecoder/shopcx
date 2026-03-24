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

// ── Helpers ──

function dollarsToCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

function extractShopifyId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

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

// ── Count ──

export async function getShopifyCounts(workspaceId: string): Promise<{ customers: number; orders: number }> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const data = await shopifyGraphQL(shop, accessToken, `{
    customersCount { count }
    ordersCount { count }
  }`);

  return {
    customers: (data.customersCount as { count: number })?.count ?? 0,
    orders: (data.ordersCount as { count: number })?.count ?? 0,
  };
}

// ── Paginated customer sync (one page at a time) ──

interface SyncPageResult {
  synced: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export async function syncCustomerPage(
  workspaceId: string,
  cursor: string | null,
  pageSize: number = 250
): Promise<SyncPageResult> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  const afterClause = cursor ? `, after: "${cursor}"` : "";
  const query = `{
    customers(first: ${pageSize}${afterClause}, sortKey: UPDATED_AT) {
      edges {
        cursor
        node {
          id
          email
          firstName
          lastName
          phone
          numberOfOrders
          amountSpent { amount }
          productSubscriberStatus
          tags
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }`;

  const data = await shopifyGraphQL(shop, accessToken, query);
  const result = data.customers as {
    edges: { cursor: string; node: Record<string, unknown> }[];
    pageInfo: { hasNextPage: boolean };
  };

  const edges = result.edges || [];
  if (edges.length === 0) {
    return { synced: 0, nextCursor: null, hasMore: false };
  }

  // Batch upsert
  const records = edges.map((edge) => {
    const c = edge.node;
    return {
      workspace_id: workspaceId,
      shopify_customer_id: extractShopifyId(c.id as string),
      email: ((c.email as string) || `no-email-${extractShopifyId(c.id as string)}@unknown.com`).toLowerCase(),
      first_name: (c.firstName as string) || null,
      last_name: (c.lastName as string) || null,
      phone: (c.phone as string) || null,
      total_orders: parseInt(c.numberOfOrders as string) || 0,
      ltv_cents: dollarsToCents((c.amountSpent as { amount?: string })?.amount),
      subscription_status: mapSubscriptionStatus(c.productSubscriberStatus as string),
      tags: (c.tags as string[]) || [],
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await admin
    .from("customers")
    .upsert(records, { onConflict: "workspace_id,shopify_customer_id" });

  if (error) {
    console.error("Customer upsert error:", error.message);
  }

  const lastCursor = edges[edges.length - 1].cursor;

  return {
    synced: error ? 0 : records.length,
    nextCursor: result.pageInfo.hasNextPage ? lastCursor : null,
    hasMore: result.pageInfo.hasNextPage,
  };
}

// ── Paginated order sync (one page at a time) ──

export async function syncOrderPage(
  workspaceId: string,
  cursor: string | null,
  pageSize: number = 250
): Promise<SyncPageResult> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  const afterClause = cursor ? `, after: "${cursor}"` : "";
  const query = `{
    orders(first: ${pageSize}${afterClause}, sortKey: UPDATED_AT) {
      edges {
        cursor
        node {
          id
          name
          email
          totalPriceSet {
            shopMoney { amount currencyCode }
          }
          displayFinancialStatus
          displayFulfillmentStatus
          createdAt
          customer { id }
          lineItems(first: 20) {
            edges {
              node {
                title
                quantity
                originalUnitPriceSet { shopMoney { amount } }
                sku
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }`;

  const data = await shopifyGraphQL(shop, accessToken, query);
  const result = data.orders as {
    edges: { cursor: string; node: Record<string, unknown> }[];
    pageInfo: { hasNextPage: boolean };
  };

  const edges = result.edges || [];
  if (edges.length === 0) {
    return { synced: 0, nextCursor: null, hasMore: false };
  }

  // Build customer lookup for this batch
  const customerGids = new Set<string>();
  const customerEmails = new Set<string>();
  for (const edge of edges) {
    const o = edge.node;
    const custGid = (o.customer as { id?: string })?.id;
    if (custGid) customerGids.add(extractShopifyId(custGid));
    const email = (o.email as string || "").toLowerCase();
    if (email) customerEmails.add(email);
  }

  const { data: customers } = await admin
    .from("customers")
    .select("id, shopify_customer_id, email")
    .eq("workspace_id", workspaceId)
    .or(
      [
        ...[...customerGids].map((gid) => `shopify_customer_id.eq.${gid}`),
        ...[...customerEmails].map((e) => `email.eq.${e}`),
      ].join(",")
    );

  const customerByShopifyId = new Map<string, string>();
  const customerByEmail = new Map<string, string>();
  for (const c of customers || []) {
    if (c.shopify_customer_id) customerByShopifyId.set(c.shopify_customer_id, c.id);
    if (c.email) customerByEmail.set(c.email.toLowerCase(), c.id);
  }

  const records = edges.map((edge) => {
    const o = edge.node;
    const shopifyOrderId = extractShopifyId(o.id as string);
    const orderEmail = ((o.email as string) || "").toLowerCase();
    const custGid = (o.customer as { id?: string })?.id;
    const shopifyCustomerId = custGid ? extractShopifyId(custGid) : null;

    let customerId: string | null = null;
    if (shopifyCustomerId) customerId = customerByShopifyId.get(shopifyCustomerId) || null;
    if (!customerId && orderEmail) customerId = customerByEmail.get(orderEmail) || null;

    const lineItemEdges = (o.lineItems as { edges: { node: Record<string, unknown> }[] })?.edges || [];
    const lineItems = lineItemEdges.map((li) => ({
      title: li.node.title,
      quantity: li.node.quantity,
      price_cents: dollarsToCents(
        (li.node.originalUnitPriceSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount
      ),
      sku: li.node.sku || null,
    }));

    const priceSet = o.totalPriceSet as { shopMoney?: { amount?: string; currencyCode?: string } };

    return {
      workspace_id: workspaceId,
      shopify_order_id: shopifyOrderId,
      customer_id: customerId,
      order_number: (o.name as string) || null,
      email: orderEmail || null,
      total_cents: dollarsToCents(priceSet?.shopMoney?.amount),
      currency: priceSet?.shopMoney?.currencyCode || "USD",
      financial_status: (o.displayFinancialStatus as string) || null,
      fulfillment_status: (o.displayFulfillmentStatus as string) || null,
      line_items: lineItems,
      created_at: (o.createdAt as string) || new Date().toISOString(),
    };
  });

  const { error } = await admin
    .from("orders")
    .upsert(records, { onConflict: "workspace_id,shopify_order_id" });

  if (error) {
    console.error("Order upsert error:", error.message);
  }

  const lastCursor = edges[edges.length - 1].cursor;

  return {
    synced: error ? 0 : records.length,
    nextCursor: result.pageInfo.hasNextPage ? lastCursor : null,
    hasMore: result.pageInfo.hasNextPage,
  };
}

// ── Finalize (order dates + retention scores) ──

export async function finalizeSyncOrderDates(workspaceId: string): Promise<void> {
  const admin = createAdminClient();
  try {
    await admin.rpc("update_customer_order_dates", { ws_id: workspaceId });
  } catch {
    console.warn("RPC update_customer_order_dates not available");
  }
}
