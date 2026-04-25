#!/usr/bin/env npx tsx
/**
 * Test: set Amazon list_price (MSRP / strikethrough) on each ASIN to match
 * the current ShopCX-set selling price (purchasable_offer ALL audience).
 *
 * Run: npx tsx scripts/test-amazon-list-price.ts            # dry-run, prints planned changes
 *      npx tsx scripts/test-amazon-list-price.ts --commit   # actually patches Amazon
 *      npx tsx scripts/test-amazon-list-price.ts --commit --only=SKU123  # one SKU only
 */

import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local
const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const match = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.+)$/);
  if (match) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
}

const COMMIT = process.argv.includes("--commit");
const ONLY = process.argv.find(a => a.startsWith("--only="))?.split("=")[1];
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function decrypt(encrypted: string): string {
  const secret = process.env.ENCRYPTION_KEY!;
  const key = Buffer.from(secret, "hex");
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

const REGION_ENDPOINTS: Record<string, string> = {
  ATVPDKIKX0DER: "https://sellingpartnerapi-na.amazon.com",
};

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(conn: { client_id_encrypted: string | null; client_secret_encrypted: string | null; refresh_token_encrypted: string }): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) return cachedToken.token;
  const clientId = conn.client_id_encrypted ? decrypt(conn.client_id_encrypted) : process.env.AMAZON_CLIENT_ID!;
  const clientSecret = conn.client_secret_encrypted ? decrypt(conn.client_secret_encrypted) : process.env.AMAZON_CLIENT_SECRET!;
  const refreshToken = decrypt(conn.refresh_token_encrypted);
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`LWA failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function spApi(token: string, marketplaceId: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const baseUrl = REGION_ENDPOINTS[marketplaceId] || REGION_ENDPOINTS.ATVPDKIKX0DER;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-amz-access-token": token,
  };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 429) {
    const retry = parseInt(res.headers.get("retry-after") ?? "2");
    await new Promise(r => setTimeout(r, retry * 1000));
    return spApi(token, marketplaceId, method, path, body);
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writes to Amazon)" : "DRY-RUN"}${ONLY ? ` — only SKU=${ONLY}` : ""}`);

  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, seller_id, marketplace_id, client_id_encrypted, client_secret_encrypted, refresh_token_encrypted")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("is_active", true)
    .maybeSingle();
  if (!conn) { console.error("No active Amazon connection"); process.exit(1); }
  console.log(`Connected: seller=${conn.seller_id} marketplace=${conn.marketplace_id}`);

  let asinQuery = admin
    .from("amazon_asins")
    .select("id, asin, sku, title")
    .eq("amazon_connection_id", conn.id)
    .eq("status", "Active");
  if (ONLY) asinQuery = asinQuery.eq("sku", ONLY);
  const { data: asins } = await asinQuery;
  if (!asins?.length) { console.error("No ASINs found"); process.exit(1); }
  console.log(`Found ${asins.length} ASIN(s)\n`);

  const token = await getAccessToken(conn);

  type Result = { sku: string; title: string; current: number | null; existingList: number | null; planned: number | null; status: "skipped" | "would-update" | "updated" | "noop" | "error"; error?: string };
  const results: Result[] = [];

  for (const a of asins) {
    if (!a.sku) { results.push({ sku: a.asin, title: a.title || "", current: null, existingList: null, planned: null, status: "skipped", error: "no SKU" }); continue; }

    // GET listing attributes
    const getPath = `/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(a.sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US&includedData=attributes`;
    const { status: gStatus, data: getData } = await spApi(token, conn.marketplace_id, "GET", getPath);
    if (gStatus !== 200) {
      results.push({ sku: a.sku, title: a.title || "", current: null, existingList: null, planned: null, status: "error", error: `GET ${gStatus}: ${JSON.stringify(getData).slice(0, 200)}` });
      continue;
    }
    const attrs = (getData as { attributes?: Record<string, unknown> }).attributes || {};
    const offers = (attrs.purchasable_offer as Array<Record<string, unknown>>) || [];
    const allOffer = offers.find(o => o.audience === "ALL" || !o.audience);
    const currentPrice = (allOffer?.our_price as Array<{ schedule?: Array<{ value_with_tax?: number }> }>)?.[0]?.schedule?.[0]?.value_with_tax ?? null;
    const listPriceArr = (attrs.list_price as Array<Record<string, unknown>>) || [];
    const existingList = ((listPriceArr[0]?.value_with_tax ?? listPriceArr[0]?.value) as number | undefined) ?? null;

    if (currentPrice == null) {
      results.push({ sku: a.sku, title: a.title || "", current: null, existingList, planned: null, status: "skipped", error: "no current price" });
      continue;
    }

    if (existingList != null && Math.abs(existingList - currentPrice) < 0.005) {
      results.push({ sku: a.sku, title: a.title || "", current: currentPrice, existingList, planned: currentPrice, status: "noop" });
      continue;
    }

    if (!COMMIT) {
      results.push({ sku: a.sku, title: a.title || "", current: currentPrice, existingList, planned: currentPrice, status: "would-update" });
      continue;
    }

    // PATCH list_price
    const patchBody = {
      productType: "PRODUCT",
      patches: [
        {
          op: "replace",
          path: "/attributes/list_price",
          value: [{ value: currentPrice, currency: "USD", marketplace_id: conn.marketplace_id }],
        },
      ],
    };
    const patchPath = `/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(a.sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US`;
    const { status: pStatus, data: pData } = await spApi(token, conn.marketplace_id, "PATCH", patchPath, patchBody);
    const issues = ((pData as { issues?: Array<{ severity: string; message: string }> })?.issues || []).filter(i => i.severity === "ERROR");
    if (pStatus >= 200 && pStatus < 300 && issues.length === 0) {
      results.push({ sku: a.sku, title: a.title || "", current: currentPrice, existingList, planned: currentPrice, status: "updated" });
    } else {
      results.push({
        sku: a.sku, title: a.title || "", current: currentPrice, existingList, planned: currentPrice, status: "error",
        error: issues[0]?.message || `PATCH ${pStatus}: ${JSON.stringify(pData).slice(0, 200)}`,
      });
    }
  }

  console.log("Results:");
  console.log("─".repeat(120));
  for (const r of results) {
    const cur = r.current != null ? `$${r.current.toFixed(2)}` : "—";
    const ex = r.existingList != null ? `$${r.existingList.toFixed(2)}` : "—";
    const pl = r.planned != null ? `$${r.planned.toFixed(2)}` : "—";
    const title = (r.title || "").slice(0, 40).padEnd(40);
    console.log(`${r.sku.padEnd(18)} ${title}  current=${cur.padStart(8)}  existingList=${ex.padStart(8)}  →  ${pl.padStart(8)}  [${r.status}]${r.error ? "  " + r.error : ""}`);
  }
  console.log("─".repeat(120));
  const counts = results.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  console.log("Summary:", counts);
}

main().catch(err => { console.error(err); process.exit(1); });
