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

// ── GraphQL ──

async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
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
    case "ACTIVE": return "active";
    case "PAUSED": return "paused";
    case "CANCELLED": case "EXPIRED": case "FAILED": return "cancelled";
    default: return "never";
  }
}

// ── Counts ──

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

// ── Multi-page sync: fetches PAGES_PER_CALL pages in one API route call ──

const PAGES_PER_CALL = 5;
const GQL_PAGE_SIZE = 250;
const UPSERT_BATCH = 250;

interface SyncPageResult {
  synced: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export async function syncCustomerPages(
  workspaceId: string,
  cursor: string | null,
): Promise<SyncPageResult> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  let currentCursor = cursor;
  let totalSynced = 0;
  let hasMore = true;

  for (let page = 0; page < PAGES_PER_CALL && hasMore; page++) {
    const afterClause = currentCursor ? `, after: "${currentCursor}"` : "";
    const query = `{
      customers(first: ${GQL_PAGE_SIZE}${afterClause}, sortKey: UPDATED_AT) {
        edges {
          cursor
          node {
            id email firstName lastName phone
            numberOfOrders
            amountSpent { amount }
            productSubscriberStatus
            tags
          }
        }
        pageInfo { hasNextPage }
      }
    }`;

    const data = await shopifyGraphQL(shop, accessToken, query);
    const result = data.customers as {
      edges: { cursor: string; node: Record<string, unknown> }[];
      pageInfo: { hasNextPage: boolean };
    };

    const edges = result.edges || [];
    if (edges.length === 0) {
      hasMore = false;
      break;
    }

    // Build records
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

    // Batch upsert
    for (let i = 0; i < records.length; i += UPSERT_BATCH) {
      const batch = records.slice(i, i + UPSERT_BATCH);
      const { error } = await admin
        .from("customers")
        .upsert(batch, { onConflict: "workspace_id,shopify_customer_id" });
      if (error) console.error("Customer upsert error:", error.message);
      else totalSynced += batch.length;
    }

    currentCursor = edges[edges.length - 1].cursor;
    hasMore = result.pageInfo.hasNextPage;
  }

  return {
    synced: totalSynced,
    nextCursor: hasMore ? currentCursor : null,
    hasMore,
  };
}

export async function syncOrderPages(
  workspaceId: string,
  cursor: string | null,
): Promise<SyncPageResult> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  // Preload ALL customer lookups once (cheap — just id + shopify_customer_id + email)
  // Cache in this closure so we don't re-fetch per page
  const { data: allCustomers } = await admin
    .from("customers")
    .select("id, shopify_customer_id, email")
    .eq("workspace_id", workspaceId);

  const customerByShopifyId = new Map<string, string>();
  const customerByEmail = new Map<string, string>();
  for (const c of allCustomers || []) {
    if (c.shopify_customer_id) customerByShopifyId.set(c.shopify_customer_id, c.id);
    if (c.email) customerByEmail.set(c.email.toLowerCase(), c.id);
  }

  let currentCursor = cursor;
  let totalSynced = 0;
  let hasMore = true;

  for (let page = 0; page < PAGES_PER_CALL && hasMore; page++) {
    const afterClause = currentCursor ? `, after: "${currentCursor}"` : "";
    const query = `{
      orders(first: ${GQL_PAGE_SIZE}${afterClause}, sortKey: UPDATED_AT) {
        edges {
          cursor
          node {
            id name email
            totalPriceSet { shopMoney { amount currencyCode } }
            displayFinancialStatus
            displayFulfillmentStatus
            createdAt
            customer { id }
            lineItems(first: 20) {
              edges {
                node {
                  title quantity sku
                  originalUnitPriceSet { shopMoney { amount } }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }`;

    const data = await shopifyGraphQL(shop, accessToken, query);
    const result = data.orders as {
      edges: { cursor: string; node: Record<string, unknown> }[];
      pageInfo: { hasNextPage: boolean };
    };

    const edges = result.edges || [];
    if (edges.length === 0) {
      hasMore = false;
      break;
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

    // Batch upsert
    for (let i = 0; i < records.length; i += UPSERT_BATCH) {
      const batch = records.slice(i, i + UPSERT_BATCH);
      const { error } = await admin
        .from("orders")
        .upsert(batch, { onConflict: "workspace_id,shopify_order_id" });
      if (error) console.error("Order upsert error:", error.message);
      else totalSynced += batch.length;
    }

    currentCursor = edges[edges.length - 1].cursor;
    hasMore = result.pageInfo.hasNextPage;
  }

  return {
    synced: totalSynced,
    nextCursor: hasMore ? currentCursor : null,
    hasMore,
  };
}

// ── Finalize ──

export async function finalizeSyncOrderDates(workspaceId: string): Promise<void> {
  const admin = createAdminClient();
  try {
    await admin.rpc("update_customer_order_dates", { ws_id: workspaceId });
  } catch {
    console.warn("RPC update_customer_order_dates not available");
  }
}
