// Shopify App Proxy HMAC-SHA256 signature verification
// Ported from subscriptions-portal/lib/shopify/appProxy.ts + requireAppProxy.ts

import crypto from "crypto";
import type { NextRequest } from "next/server";

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify Shopify App Proxy signature.
 * Steps:
 * 1. Take all query params except `signature`
 * 2. Sort by key lexicographically
 * 3. Concatenate `key=value` with NO separators
 * 4. HMAC-SHA256(secret, message) → hex
 * 5. Compare with timing-safe equality
 */
function isValidAppProxyRequest(url: URL, secret: string): boolean {
  const provided = url.searchParams.get("signature") || "";
  if (!provided) return false;

  const params = new URLSearchParams(url.search);
  params.delete("signature");

  const keys = Array.from(new Set(Array.from(params.keys()))).sort();
  const pairs: string[] = [];
  for (const key of keys) {
    const values = params.getAll(key);
    pairs.push(`${key}=${values.join(",")}`);
  }

  const message = pairs.join("");
  const computed = crypto.createHmac("sha256", secret.trim()).update(message).digest("hex");

  return timingSafeEqual(computed, provided);
}

export interface PortalAuthResult {
  shop: string;
  loggedInCustomerId: string;
  workspaceId: string;
}

/**
 * Authenticate a portal request via Shopify App Proxy HMAC.
 * Returns shop, customer ID, and resolved workspace ID.
 * Throws on invalid signature.
 */
export async function requireAppProxy(req: NextRequest): Promise<PortalAuthResult> {
  const secret = process.env.SHOPIFY_APP_PROXY_SECRET?.trim();
  if (!secret) throw new Error("Missing SHOPIFY_APP_PROXY_SECRET");

  const url = new URL(req.url);

  // Allow HEAD without signature (health checks)
  if (req.method === "HEAD") {
    return {
      shop: url.searchParams.get("shop") || "",
      loggedInCustomerId: url.searchParams.get("logged_in_customer_id") || "",
      workspaceId: "",
    };
  }

  if (!isValidAppProxyRequest(url, secret)) {
    throw new Error("APP_PROXY_INVALID_SIGNATURE");
  }

  const shop = url.searchParams.get("shop") || "";

  // Resolve workspace from shop domain
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .eq("shopify_myshopify_domain", shop)
    .single();

  return {
    shop,
    loggedInCustomerId: url.searchParams.get("logged_in_customer_id") || "",
    workspaceId: workspace?.id || "",
  };
}
