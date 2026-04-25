#!/usr/bin/env npx tsx
/**
 * Delete the `discounted_price` (sale price) field from every active
 * Amazon listing's ALL audience purchasable_offer.
 *
 * Run: npx tsx scripts/clear-amazon-sale-prices.ts            # dry-run
 *      npx tsx scripts/clear-amazon-sale-prices.ts --commit
 *      npx tsx scripts/clear-amazon-sale-prices.ts --commit --only=SKU
 */

import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const COMMIT = process.argv.includes("--commit");
const ONLY = process.argv.find(a => a.startsWith("--only="))?.split("=")[1];
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function decrypt(encrypted: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  const [ivHex, tagHex, ctHex] = encrypted.split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return d.update(Buffer.from(ctHex, "hex")).toString("utf8") + d.final("utf8");
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT" : "DRY-RUN"}${ONLY ? ` only=${ONLY}` : ""}`);

  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, seller_id, marketplace_id, client_id_encrypted, client_secret_encrypted, refresh_token_encrypted")
    .eq("workspace_id", WORKSPACE_ID).eq("is_active", true).single();
  if (!conn) { console.error("No connection"); process.exit(1); }

  const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decrypt(conn.refresh_token_encrypted),
      client_id: conn.client_id_encrypted ? decrypt(conn.client_id_encrypted) : process.env.AMAZON_CLIENT_ID!,
      client_secret: conn.client_secret_encrypted ? decrypt(conn.client_secret_encrypted) : process.env.AMAZON_CLIENT_SECRET!,
    }),
  });
  const { access_token } = await tokenRes.json();

  let asinQuery = admin.from("amazon_asins").select("sku, title").eq("amazon_connection_id", conn.id).eq("status", "Active");
  if (ONLY) asinQuery = asinQuery.eq("sku", ONLY);
  const { data: asins } = await asinQuery;
  if (!asins?.length) { console.error("No ASINs"); process.exit(1); }

  const results: Array<{ sku: string; status: string; note?: string }> = [];

  for (const a of asins) {
    if (!a.sku) continue;
    // Read current
    const getUrl = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(a.sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US&includedData=attributes`;
    const gRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${access_token}`, "x-amz-access-token": access_token } });
    if (!gRes.ok) { results.push({ sku: a.sku, status: "error", note: `GET ${gRes.status}` }); continue; }
    const data = await gRes.json();
    const offers = (data.attributes?.purchasable_offer || []) as Array<Record<string, unknown>>;
    const allOffer = offers.find(o => o.audience === "ALL" || !o.audience);
    if (!allOffer) { results.push({ sku: a.sku, status: "no-all-offer" }); continue; }
    const hasDiscounted = Array.isArray(allOffer.discounted_price) && allOffer.discounted_price.length > 0;
    if (!hasDiscounted) { results.push({ sku: a.sku, status: "no-sale" }); continue; }

    if (!COMMIT) { results.push({ sku: a.sku, status: "would-clear" }); continue; }

    // Replace ALL audience purchasable_offer with our_price only — omitting discounted_price clears it.
    // (Do NOT use `op: "delete"` with a nested-field selector; it nukes the whole parent entry.)
    const ourPrice = allOffer.our_price;
    if (!ourPrice) { results.push({ sku: a.sku, status: "error", note: "no our_price to preserve — refusing to patch" }); continue; }
    const patchBody = {
      productType: "PRODUCT",
      patches: [
        {
          op: "replace",
          path: "/attributes/purchasable_offer",
          value: [
            {
              currency: "USD",
              audience: "ALL",
              marketplace_id: conn.marketplace_id,
              our_price: ourPrice,
            },
          ],
        },
      ],
    };
    const pUrl = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(a.sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US`;
    const pRes = await fetch(pUrl, { method: "PATCH", headers: { Authorization: `Bearer ${access_token}`, "x-amz-access-token": access_token, "Content-Type": "application/json" }, body: JSON.stringify(patchBody) });
    const pData = await pRes.json().catch(() => null);
    const issues = ((pData?.issues || []) as Array<{ severity: string; message: string }>).filter(i => i.severity === "ERROR");
    if (pRes.ok && issues.length === 0) {
      results.push({ sku: a.sku, status: "cleared", note: `submission=${pData?.submissionId || "?"}` });
    } else {
      results.push({ sku: a.sku, status: "error", note: issues[0]?.message || `PATCH ${pRes.status}: ${JSON.stringify(pData).slice(0, 300)}` });
    }
  }

  for (const r of results) console.log(`${r.sku.padEnd(22)} [${r.status}]${r.note ? "  " + r.note : ""}`);
  const counts = results.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  console.log("\nSummary:", counts);
}

main().catch(e => { console.error(e); process.exit(1); });
