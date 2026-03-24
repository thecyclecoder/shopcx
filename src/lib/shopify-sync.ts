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

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      // Retry on 429 (rate limit) and 5xx
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = res.status === 429 ? 2000 : 1000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      // Network errors (ECONNRESET, etc) — retry
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("fetchWithRetry: exhausted retries");
}

async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(
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

// ── Bulk Operations (for initial large syncs) ──

const BULK_CUSTOMERS_QUERY = `
  mutation {
    bulkOperationRunQuery(
      query: """
      {
        customers {
          edges {
            node {
              id email firstName lastName phone
              numberOfOrders
              amountSpent { amount }
              productSubscriberStatus
              tags
            }
          }
        }
      }
      """
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const BULK_POLL_QUERY = `{
  currentBulkOperation {
    id status errorCode objectCount url
  }
}`;

// Cancel any running bulk operation (prevents conflicts)
export async function cancelBulkOperation(workspaceId: string): Promise<void> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  // Check if one is running
  const pollData = await shopifyGraphQL(shop, accessToken, BULK_POLL_QUERY);
  const op = pollData.currentBulkOperation as { id: string; status: string } | null;

  if (op && (op.status === "RUNNING" || op.status === "CREATED")) {
    await shopifyGraphQL(shop, accessToken,
      `mutation { bulkOperationCancel(id: "${op.id}") { bulkOperation { id status } userErrors { field message } } }`
    );
    // Wait for cancellation to complete
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const check = await shopifyGraphQL(shop, accessToken, BULK_POLL_QUERY);
      const checkOp = check.currentBulkOperation as { status: string } | null;
      if (!checkOp || checkOp.status === "CANCELED" || checkOp.status === "CANCELLED" || checkOp.status === "COMPLETED") break;
    }
  }
}

// Start a bulk operation (returns immediately)
export async function startBulkOperation(workspaceId: string, mutation: string): Promise<string> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
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
  return result.bulkOperation.id;
}

// Poll bulk operation status — returns url if complete, null if still running
export async function pollBulkOperation(workspaceId: string): Promise<{
  status: "running" | "completed" | "failed";
  objectCount: number;
  url: string | null;
}> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const pollData = await shopifyGraphQL(shop, accessToken, BULK_POLL_QUERY);
  const op = pollData.currentBulkOperation as {
    status: string; errorCode: string | null; objectCount: string; url: string | null;
  } | null;

  if (!op) return { status: "failed", objectCount: 0, url: null };

  if (op.status === "COMPLETED") {
    return { status: "completed", objectCount: parseInt(op.objectCount) || 0, url: op.url };
  }
  if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "CANCELLED") {
    return { status: "failed", objectCount: parseInt(op.objectCount) || 0, url: null };
  }

  return { status: "running", objectCount: parseInt(op.objectCount) || 0, url: null };
}

const BULK_ORDERS_QUERY = `
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
              tags
              sourceIdentifier
              totalPriceSet { shopMoney { amount currencyCode } }
              displayFinancialStatus
              displayFulfillmentStatus
              createdAt
              customer { id }
              lineItems(first: 20) {
                edges {
                  node {
                    title
                    quantity
                    sku
                    originalUnitPriceSet { shopMoney { amount } }
                  }
                }
              }
            }
          }
        }
      }
      """
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

export async function bulkSyncOrders(
  workspaceId: string,
  onProgress?: (synced: number) => Promise<void>,
): Promise<number> {
  const admin = createAdminClient();

  const pollResult = await pollBulkOperation(workspaceId);
  if (pollResult.status !== "completed" || !pollResult.url) {
    throw new Error("Bulk operation not completed or no download URL");
  }
  const lines = await downloadBulkResults(pollResult.url);

  // Preload customer lookup
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

  // Parse JSONL — orders and their child line items come as separate lines
  const orderMap = new Map<string, Record<string, unknown>>();
  const lineItemsMap = new Map<string, Record<string, unknown>[]>();

  for (const line of lines) {
    const obj = JSON.parse(line);
    if (obj.__parentId) {
      // Child line item
      const parentId = obj.__parentId as string;
      if (!lineItemsMap.has(parentId)) lineItemsMap.set(parentId, []);
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

  let synced = 0;
  const records: Record<string, unknown>[] = [];

  for (const [gid, o] of orderMap) {
    const shopifyOrderId = extractShopifyId(gid);
    const orderEmail = ((o.email as string) || "").toLowerCase();
    const custGid = (o.customer as { id?: string })?.id;
    const shopifyCustomerId = custGid ? extractShopifyId(custGid) : null;

    let customerId: string | null = null;
    if (shopifyCustomerId) customerId = customerByShopifyId.get(shopifyCustomerId) || null;
    if (!customerId && orderEmail) customerId = customerByEmail.get(orderEmail) || null;

    const priceSet = o.totalPriceSet as { shopMoney?: { amount?: string; currencyCode?: string } };

    records.push({
      workspace_id: workspaceId,
      shopify_order_id: shopifyOrderId,
      customer_id: customerId,
      order_number: (o.name as string) || null,
      email: orderEmail || null,
      total_cents: dollarsToCents(priceSet?.shopMoney?.amount),
      currency: priceSet?.shopMoney?.currencyCode || "USD",
      financial_status: (o.displayFinancialStatus as string) || null,
      fulfillment_status: (o.displayFulfillmentStatus as string) || null,
      line_items: lineItemsMap.get(gid) || [],
      source_name: (o.sourceIdentifier as string) || null,
      tags: (o.tags as string[])?.join(", ") || null,
      created_at: (o.createdAt as string) || new Date().toISOString(),
    });
  }

  // Batch upsert
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    const batch = records.slice(i, i + UPSERT_BATCH);
    const { error } = await admin
      .from("orders")
      .upsert(batch, { onConflict: "workspace_id,shopify_order_id" });
    if (!error) synced += batch.length;
    else console.error("Bulk order upsert error:", error.message);

    if (onProgress && i % 2500 === 0) await onProgress(synced);
  }

  return synced;
}

export { BULK_CUSTOMERS_QUERY, BULK_ORDERS_QUERY };

async function downloadBulkResults(url: string): Promise<string[]> {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download bulk results: ${res.status}`);
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean);
}

export async function bulkSyncCustomers(
  workspaceId: string,
  onProgress?: (synced: number) => Promise<void>,
): Promise<number> {
  const admin = createAdminClient();

  // Get the completed bulk operation's download URL
  const pollResult = await pollBulkOperation(workspaceId);
  if (pollResult.status !== "completed" || !pollResult.url) {
    throw new Error("Bulk operation not completed or no download URL");
  }
  const lines = await downloadBulkResults(pollResult.url);

  let synced = 0;
  const records: Record<string, unknown>[] = [];

  for (const line of lines) {
    const c = JSON.parse(line);
    if (c.__parentId) continue;
    if (!c.id?.includes("Customer")) continue;
    // Use phone as fallback identifier if no email
    const email = c.email
      ? c.email.toLowerCase()
      : c.phone
        ? `${c.phone.replace(/\D/g, "")}@phone.local`
        : null;
    if (!email) continue; // Skip if no email AND no phone

    records.push({
      workspace_id: workspaceId,
      shopify_customer_id: extractShopifyId(c.id),
      email,
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
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    const batch = records.slice(i, i + UPSERT_BATCH);
    const { error } = await admin
      .from("customers")
      .upsert(batch, { onConflict: "workspace_id,shopify_customer_id" });
    if (!error) synced += batch.length;
    else console.error("Bulk customer upsert error:", error.message);

    if (onProgress && i % 2500 === 0) await onProgress(synced);
  }

  return synced;
}

// ── Multi-page sync: fetches PAGES_PER_CALL pages in one API route call ──

const PAGES_PER_CALL = 10; // 2,500 records per call
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

    // Build records — use phone as fallback identifier
    const records = edges
      .filter((edge) => {
        const c = edge.node;
        return !!(c.email as string) || !!(c.phone as string);
      })
      .map((edge) => {
      const c = edge.node;
      const email = (c.email as string)
        ? (c.email as string).toLowerCase()
        : `${(c.phone as string).replace(/\D/g, "")}@phone.local`;
      return {
        workspace_id: workspaceId,
        shopify_customer_id: extractShopifyId(c.id as string),
        email,
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

// ── REST-based order sync (no 60-day limit, includes source_name) ──

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export async function syncOrderPages(
  workspaceId: string,
  cursor: string | null, // cursor here is the full next URL or null for first page
): Promise<SyncPageResult> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  // Preload customer lookups once
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

  let nextUrl: string | null = cursor ||
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?limit=250&status=any`;

  let totalSynced = 0;
  let hasMore = true;

  for (let page = 0; page < PAGES_PER_CALL && hasMore && nextUrl; page++) {
    const res = await fetchWithRetry(nextUrl, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify orders fetch failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const orders = data.orders || [];

    if (orders.length === 0) {
      hasMore = false;
      break;
    }

    const records = orders.map((o: Record<string, unknown>) => {
      const shopifyOrderId = String(o.id);
      const orderEmail = ((o.email as string) || "").toLowerCase();
      const shopifyCustomerId = (o.customer as { id?: number })?.id
        ? String((o.customer as { id: number }).id)
        : null;

      let customerId: string | null = null;
      if (shopifyCustomerId) customerId = customerByShopifyId.get(shopifyCustomerId) || null;
      if (!customerId && orderEmail) customerId = customerByEmail.get(orderEmail) || null;

      const lineItems = ((o.line_items as Record<string, unknown>[]) || []).map((li) => ({
        title: li.title,
        quantity: li.quantity,
        price_cents: dollarsToCents(li.price as string),
        sku: li.sku || null,
      }));

      return {
        workspace_id: workspaceId,
        shopify_order_id: shopifyOrderId,
        customer_id: customerId,
        order_number: (o.name as string) || String(o.order_number) || null,
        email: orderEmail || null,
        total_cents: dollarsToCents(o.total_price as string),
        currency: (o.currency as string) || "USD",
        financial_status: (o.financial_status as string) || null,
        fulfillment_status: (o.fulfillment_status as string) || null,
        line_items: lineItems,
        source_name: (o.source_name as string) || null,
        app_id: (o.app_id as number) || null,
        tags: (o.tags as string) || null,
        created_at: (o.created_at as string) || new Date().toISOString(),
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

    nextUrl = parseLinkHeader(res.headers.get("link"));
    hasMore = !!nextUrl;
  }

  return {
    synced: totalSynced,
    nextCursor: hasMore ? nextUrl : null,
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
