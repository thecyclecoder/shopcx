import { createHmac, randomBytes } from "crypto";

export const SHOPIFY_API_VERSION = "2025-07";
export const SHOPIFY_SCOPES =
  "read_all_orders,read_customers,write_customers,read_discounts,write_discounts,write_draft_orders,read_inventory,read_merchant_managed_fulfillment_orders,read_orders,write_orders,read_product_listings,read_products,read_publications,read_shopify_payments_disputes,read_themes,write_themes,read_channels,read_store_credit_accounts,read_store_credit_account_transactions,write_store_credit_account_transactions";

export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

export function buildShopifyAuthUrl({
  shopDomain,
  clientId,
  redirectUri,
  state,
}: {
  shopDomain: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SHOPIFY_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shopDomain}.myshopify.com/admin/oauth/authorize?${params}`;
}

export function verifyShopifyHmac(
  query: Record<string, string>,
  clientSecret: string
): boolean {
  const hmac = query.hmac;
  if (!hmac) return false;

  // Build message from all params except hmac
  const entries = Object.entries(query)
    .filter(([key]) => key !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b));

  const message = entries.map(([k, v]) => `${k}=${v}`).join("&");
  const computed = createHmac("sha256", clientSecret).update(message).digest("hex");

  // Timing-safe comparison
  if (computed.length !== hmac.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ hmac.charCodeAt(i);
  }
  return result === 0;
}

export async function exchangeShopifyCode({
  shop,
  clientId,
  clientSecret,
  code,
}: {
  shop: string;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<{ access_token: string; scope: string }> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token exchange failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function fetchShopDetails(
  shop: string,
  accessToken: string
): Promise<{ myshopify_domain: string; name: string; domain: string }> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch shop details: ${res.status}`);
  }

  const data = await res.json();
  return {
    myshopify_domain: data.shop.myshopify_domain,
    name: data.shop.name,
    domain: data.shop.domain,
  };
}
