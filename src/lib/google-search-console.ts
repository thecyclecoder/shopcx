/**
 * Google Search Console API client.
 * Retrieves search analytics (queries, clicks, impressions, CTR, position).
 *
 * Auth: Service account JSON credentials stored encrypted in workspaces.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const SC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

export interface SearchQuery {
  keyword: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

async function getConfig(workspaceId: string): Promise<{ credentials: ServiceAccountKey; siteUrl: string } | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("google_search_console_credentials_encrypted, google_search_console_site_url")
    .eq("id", workspaceId)
    .single();

  if (!ws?.google_search_console_credentials_encrypted || !ws?.google_search_console_site_url) return null;

  try {
    const creds = JSON.parse(decrypt(ws.google_search_console_credentials_encrypted)) as ServiceAccountKey;
    return { credentials: creds, siteUrl: ws.google_search_console_site_url };
  } catch {
    return null;
  }
}

/**
 * Create a JWT and exchange it for an access token using service account credentials.
 */
async function getAccessToken(creds: ServiceAccountKey): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: creds.token_uri || "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));

    // Sign JWT with the private key
    const { createSign } = await import("crypto");
    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(creds.private_key, "base64url");

    const jwt = `${header}.${payload}.${signature}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!res.ok) {
      console.error("[gsc] Token exchange failed:", await res.text());
      return null;
    }

    const data = await res.json();
    return data.access_token || null;
  } catch (err) {
    console.error("[gsc] JWT signing failed:", err);
    return null;
  }
}

/**
 * Get search analytics for a site, optionally filtered by page URL pattern.
 * Returns top queries by clicks for the last 90 days.
 */
export async function getSearchAnalytics(
  workspaceId: string,
  options?: {
    pageFilter?: string; // e.g. "/amazing-coffee" — filter to a specific page
    days?: number; // default 90
    limit?: number; // default 100
  },
): Promise<SearchQuery[]> {
  const config = await getConfig(workspaceId);
  if (!config) return [];

  const accessToken = await getAccessToken(config.credentials);
  if (!accessToken) return [];

  const days = options?.days || 90;
  const endDate = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const body: Record<string, unknown> = {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
    dimensions: ["query"],
    rowLimit: options?.limit || 100,
    dataState: "all",
  };

  if (options?.pageFilter) {
    body.dimensionFilterGroups = [{
      filters: [{
        dimension: "page",
        operator: "contains",
        expression: options.pageFilter,
      }],
    }];
  }

  const siteUrl = encodeURIComponent(config.siteUrl);
  const res = await fetch(`${SC_BASE}/sites/${siteUrl}/searchAnalytics/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error("[gsc] Search analytics failed:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  return (data.rows || []).map((row: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }) => ({
    keyword: row.keys?.[0] || "",
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: row.ctr || 0,
    position: row.position || 0,
  }));
}
