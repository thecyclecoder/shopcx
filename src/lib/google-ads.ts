/**
 * Google Ads Keyword Planner API client.
 * Uses REST API (not the Node.js client library) to keep the bundle small.
 *
 * Auth: OAuth2 with refresh token → access token.
 * Endpoint: KeywordPlanIdeaService.GenerateKeywordIdeas
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_API_VERSION = "v17";
const ADS_BASE = `https://googleads.googleapis.com/${ADS_API_VERSION}`;

export interface KeywordIdea {
  keyword: string;
  monthly_searches: number;
  competition: "LOW" | "MEDIUM" | "HIGH" | "UNSPECIFIED";
  competition_index: number;
  cpc_low_cents: number;
  cpc_high_cents: number;
}

interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
}

async function getConfig(workspaceId: string): Promise<GoogleAdsConfig | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("google_ads_developer_token_encrypted, google_ads_client_id, google_ads_client_secret_encrypted, google_ads_refresh_token_encrypted, google_ads_customer_id")
    .eq("id", workspaceId)
    .single();

  if (!ws?.google_ads_developer_token_encrypted || !ws?.google_ads_client_id || !ws?.google_ads_client_secret_encrypted || !ws?.google_ads_refresh_token_encrypted || !ws?.google_ads_customer_id) {
    return null;
  }

  return {
    developerToken: decrypt(ws.google_ads_developer_token_encrypted),
    clientId: ws.google_ads_client_id,
    clientSecret: decrypt(ws.google_ads_client_secret_encrypted),
    refreshToken: decrypt(ws.google_ads_refresh_token_encrypted),
    customerId: ws.google_ads_customer_id.replace(/-/g, ""),
  };
}

async function getAccessToken(config: GoogleAdsConfig): Promise<string | null> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
    }),
  });

  if (!res.ok) {
    console.error("[google-ads] Token refresh failed:", await res.text());
    return null;
  }

  const data = await res.json();
  return data.access_token || null;
}

/**
 * Generate keyword ideas from seed keywords using Google Ads Keyword Planner.
 * Returns real search volume, competition, and CPC data.
 */
export async function generateKeywordIdeas(
  workspaceId: string,
  seedKeywords: string[],
  language?: string,
  country?: string,
): Promise<KeywordIdea[]> {
  const config = await getConfig(workspaceId);
  if (!config) return [];

  const accessToken = await getAccessToken(config);
  if (!accessToken) return [];

  // Language and geo targeting
  const languageCode = language || "en";
  const countryCode = country || "US";
  const languageId = languageCode === "en" ? "1000" : "1000"; // English
  const geoId = countryCode === "US" ? "2840" : "2840"; // United States

  const body = {
    keywordSeed: {
      keywords: seedKeywords.slice(0, 20), // API limit
    },
    language: `customers/${config.customerId}/languageConstants/${languageId}`,
    geoTargetConstants: [`customers/${config.customerId}/geoTargetConstants/${geoId}`],
    keywordPlanNetwork: "GOOGLE_SEARCH",
  };

  const res = await fetch(
    `${ADS_BASE}/customers/${config.customerId}:generateKeywordIdeas`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": config.developerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    console.error("[google-ads] Keyword ideas failed:", res.status, err);
    return [];
  }

  const data = await res.json();
  const results = data.results || [];

  return results.map((r: {
    text?: string;
    keywordIdeaMetrics?: {
      avgMonthlySearches?: string;
      competition?: string;
      competitionIndex?: string;
      lowTopOfPageBidMicros?: string;
      highTopOfPageBidMicros?: string;
    };
  }) => ({
    keyword: r.text || "",
    monthly_searches: parseInt(r.keywordIdeaMetrics?.avgMonthlySearches || "0"),
    competition: (r.keywordIdeaMetrics?.competition || "UNSPECIFIED") as KeywordIdea["competition"],
    competition_index: parseFloat(r.keywordIdeaMetrics?.competitionIndex || "0"),
    cpc_low_cents: Math.round(parseInt(r.keywordIdeaMetrics?.lowTopOfPageBidMicros || "0") / 10000),
    cpc_high_cents: Math.round(parseInt(r.keywordIdeaMetrics?.highTopOfPageBidMicros || "0") / 10000),
  })).filter((k: KeywordIdea) => k.keyword && k.monthly_searches > 0);
}
