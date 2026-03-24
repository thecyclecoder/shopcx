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

  if (error || !workspace) {
    throw new Error("Workspace not found");
  }

  if (!workspace.shopify_access_token_encrypted) {
    throw new Error("Shopify is not connected for this workspace");
  }

  if (!workspace.shopify_myshopify_domain) {
    throw new Error("Shopify domain not configured for this workspace");
  }

  return {
    shop: workspace.shopify_myshopify_domain,
    accessToken: decrypt(workspace.shopify_access_token_encrypted),
  };
}

export async function shopifyFetch(
  shop: string,
  accessToken: string,
  path: string
): Promise<Response> {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Shopify API error: ${res.status} ${text} (${path})`
    );
  }

  return res;
}

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

function dollarsToCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

export async function syncCustomers(
  workspaceId: string
): Promise<number> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  let synced = 0;
  let nextUrl: string | null =
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/customers.json?limit=250`;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify customers fetch failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const customers = data.customers || [];

    for (const c of customers) {
      const { error } = await admin.from("customers").upsert(
        {
          workspace_id: workspaceId,
          shopify_customer_id: String(c.id),
          email: (c.email || "").toLowerCase(),
          first_name: c.first_name || null,
          last_name: c.last_name || null,
          phone: c.phone || null,
          total_orders: c.orders_count ?? 0,
          ltv_cents: dollarsToCents(c.total_spent),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,shopify_customer_id" }
      );

      if (!error) synced++;
    }

    nextUrl = parseLinkHeader(res.headers.get("link"));
  }

  return synced;
}

export async function syncOrders(
  workspaceId: string
): Promise<number> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const admin = createAdminClient();

  let synced = 0;
  let nextUrl: string | null =
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?limit=250&status=any`;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
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

    for (const o of orders) {
      const orderEmail = (o.email || "").toLowerCase();
      const shopifyCustomerId = o.customer?.id
        ? String(o.customer.id)
        : null;

      // Look up customer_id
      let customerId: string | null = null;

      if (shopifyCustomerId) {
        const { data: customer } = await admin
          .from("customers")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("shopify_customer_id", shopifyCustomerId)
          .single();
        if (customer) customerId = customer.id;
      }

      if (!customerId && orderEmail) {
        const { data: customer } = await admin
          .from("customers")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("email", orderEmail)
          .single();
        if (customer) customerId = customer.id;
      }

      // Simplify line items
      const lineItems = (o.line_items || []).map(
        (li: { title?: string; quantity?: number; price?: string; sku?: string }) => ({
          title: li.title,
          quantity: li.quantity,
          price_cents: dollarsToCents(li.price),
          sku: li.sku || null,
        })
      );

      const { error } = await admin.from("orders").upsert(
        {
          workspace_id: workspaceId,
          shopify_order_id: String(o.id),
          customer_id: customerId,
          order_number: o.name || String(o.order_number) || null,
          email: orderEmail || null,
          total_cents: dollarsToCents(o.total_price),
          currency: o.currency || "USD",
          financial_status: o.financial_status || null,
          fulfillment_status: o.fulfillment_status || null,
          line_items: lineItems,
          created_at: o.created_at || new Date().toISOString(),
        },
        { onConflict: "workspace_id,shopify_order_id" }
      );

      if (!error) synced++;
    }

    nextUrl = parseLinkHeader(res.headers.get("link"));
  }

  // Update first_order_at and last_order_at on customer records
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId);

  if (customers) {
    for (const customer of customers) {
      const { data: firstOrder } = await admin
        .from("orders")
        .select("created_at")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .single();

      const { data: lastOrder } = await admin
        .from("orders")
        .select("created_at")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (firstOrder || lastOrder) {
        await admin
          .from("customers")
          .update({
            first_order_at: firstOrder?.created_at || null,
            last_order_at: lastOrder?.created_at || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", customer.id);
      }
    }
  }

  return synced;
}
