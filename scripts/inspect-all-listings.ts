#!/usr/bin/env npx tsx
/** Quick health check: report any ASINs missing purchasable_offer ALL / our_price. */
import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

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
  const { data: conn } = await admin.from("amazon_connections").select("*").eq("workspace_id", WORKSPACE_ID).eq("is_active", true).single();
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
  const { data: asins } = await admin.from("amazon_asins").select("sku, title").eq("amazon_connection_id", conn.id).eq("status", "Active");
  for (const a of asins || []) {
    if (!a.sku) continue;
    const url = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(a.sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US&includedData=attributes`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, "x-amz-access-token": access_token } });
    const d = await r.json();
    const offers = d.attributes?.purchasable_offer || [];
    const allOffer = offers.find((o: { audience?: string }) => o.audience === "ALL" || !o.audience);
    const ourPrice = allOffer?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
    const flag = !ourPrice ? "  ⚠️  MISSING our_price" : "";
    console.log(`${a.sku.padEnd(22)}  our_price=${ourPrice ?? "—"}${flag}`);
  }
})();
