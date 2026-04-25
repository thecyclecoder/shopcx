#!/usr/bin/env npx tsx
import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const SKU = process.argv[2];
if (!SKU) { console.error("Usage: npx tsx scripts/inspect-amazon-listing.ts SKU"); process.exit(1); }
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function decrypt(encrypted: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  const [ivHex, tagHex, ctHex] = encrypted.split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return d.update(Buffer.from(ctHex, "hex")).toString("utf8") + d.final("utf8");
}

(async () => {
  const { data: conn } = await admin.from("amazon_connections").select("id, seller_id, marketplace_id, client_id_encrypted, client_secret_encrypted, refresh_token_encrypted").eq("workspace_id", WORKSPACE_ID).eq("is_active", true).single();
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
  const url = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(SKU)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US&includedData=attributes`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, "x-amz-access-token": access_token } });
  const data = await res.json();
  console.log(JSON.stringify({ purchasable_offer: data.attributes?.purchasable_offer, list_price: data.attributes?.list_price }, null, 2));
})();
