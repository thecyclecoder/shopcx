// Amazon SP-API authentication + request helper
// Uses LWA OAuth with refresh token, caches access tokens in DB

import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

export async function getAccessToken(connectionId: string): Promise<string> {
  const admin = createAdminClient();
  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, refresh_token_encrypted, access_token_encrypted, access_token_expires_at")
    .eq("id", connectionId)
    .single();

  if (!conn) throw new Error("Amazon connection not found");

  // Return cached token if still valid (5-min buffer)
  if (conn.access_token_encrypted && conn.access_token_expires_at) {
    const bufferMs = 5 * 60 * 1000;
    if (new Date(conn.access_token_expires_at).getTime() > Date.now() + bufferMs) {
      return decrypt(conn.access_token_encrypted);
    }
  }

  const clientId = process.env.AMAZON_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("AMAZON_CLIENT_ID and AMAZON_CLIENT_SECRET must be set");

  const refreshToken = decrypt(conn.refresh_token_encrypted);

  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LWA token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const accessToken = data.access_token as string;
  const expiresIn = (data.expires_in as number) || 3600;

  // Cache the token (encrypted)
  await admin.from("amazon_connections").update({
    access_token_encrypted: encrypt(accessToken),
    access_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }).eq("id", connectionId);

  return accessToken;
}

// Marketplace ID → SP-API regional endpoint
const REGION_ENDPOINTS: Record<string, string> = {
  ATVPDKIKX0DER: "https://sellingpartnerapi-na.amazon.com",   // US
  A2EUQ1WTGCTBG2: "https://sellingpartnerapi-na.amazon.com",  // CA
  A1AM78C64UM0Y8: "https://sellingpartnerapi-na.amazon.com",  // MX
  A1F83G8C2ARO7P: "https://sellingpartnerapi-eu.amazon.com",  // UK
  A13V1IB3VIYZZH: "https://sellingpartnerapi-eu.amazon.com",  // FR
  A1PA6795UKMFR9: "https://sellingpartnerapi-eu.amazon.com",  // DE
  A1RKKUPIHCS9HS: "https://sellingpartnerapi-eu.amazon.com",  // ES
  APJ6JRA9NG5V4: "https://sellingpartnerapi-eu.amazon.com",   // IT
  A1VC38T7YXB528: "https://sellingpartnerapi-fe.amazon.com",  // JP
  AAHKV2X7AFYLW: "https://sellingpartnerapi-fe.amazon.com",   // CN
  A39IBJ37TRP1C6: "https://sellingpartnerapi-fe.amazon.com",  // AU
};

export function getSpApiEndpoint(marketplaceId: string): string {
  return REGION_ENDPOINTS[marketplaceId] ?? REGION_ENDPOINTS.ATVPDKIKX0DER;
}

export async function spApiRequest(
  connectionId: string,
  marketplaceId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = await getAccessToken(connectionId);
  const baseUrl = getSpApiEndpoint(marketplaceId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-amz-access-token": token,
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Rate limiting — retry after delay
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "2");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return spApiRequest(connectionId, marketplaceId, method, path, body);
  }

  return res;
}
