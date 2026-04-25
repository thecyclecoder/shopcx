#!/usr/bin/env npx tsx
/**
 * Check each ASIN for an active "sale price" (discounted_price) on Amazon.
 * Run: npx tsx scripts/check-amazon-sale-prices.ts
 */

import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const match = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.+)$/);
  if (match) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
}

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function decrypt(encrypted: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(ciphertextHex, "hex")).toString("utf8") + decipher.final("utf8");
}

async function main() {
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

  const { data: asins } = await admin
    .from("amazon_asins")
    .select("sku, title").eq("amazon_connection_id", conn.id).eq("status", "Active");

  console.log(`Checking ${asins?.length || 0} listings for active sale prices…\n`);
  const withSale: Array<{ sku: string; title: string; ourPrice: number | null; salePrice: number; startAt: string | null; endAt: string | null }> = [];

  for (const a of asins || []) {
    if (!a.sku) continue;
    const res = await fetch(
      `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(a.sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US&includedData=attributes`,
      { headers: { Authorization: `Bearer ${access_token}`, "x-amz-access-token": access_token } },
    );
    if (!res.ok) { console.log(`${a.sku}: GET ${res.status}`); continue; }
    const data = await res.json();
    const offers = (data.attributes?.purchasable_offer || []) as Array<Record<string, unknown>>;
    const allOffer = offers.find(o => o.audience === "ALL" || !o.audience);
    if (!allOffer) continue;
    const ourPrice = (allOffer.our_price as Array<{ schedule?: Array<{ value_with_tax?: number }> }>)?.[0]?.schedule?.[0]?.value_with_tax ?? null;
    const discounted = (allOffer.discounted_price as Array<{ schedule?: Array<{ value_with_tax?: number; start_at?: string; end_at?: string }> }>) || [];
    for (const dp of discounted) {
      for (const sch of dp.schedule || []) {
        if (sch.value_with_tax != null) {
          withSale.push({
            sku: a.sku,
            title: (a.title || "").slice(0, 50),
            ourPrice,
            salePrice: sch.value_with_tax,
            startAt: sch.start_at || null,
            endAt: sch.end_at || null,
          });
        }
      }
    }
  }

  if (withSale.length === 0) {
    console.log("No active sale prices (discounted_price) found on any listing.");
  } else {
    console.log(`Found ${withSale.length} active sale price(s):\n`);
    for (const s of withSale) {
      console.log(`${s.sku.padEnd(20)} ${s.title.padEnd(52)} regular=$${s.ourPrice?.toFixed(2)}  sale=$${s.salePrice.toFixed(2)}  ${s.startAt || "?"} → ${s.endAt || "?"}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
