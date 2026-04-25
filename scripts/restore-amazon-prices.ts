#!/usr/bin/env npx tsx
/** Restore selling prices on Amazon listings that lost their purchasable_offer. */
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
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Snapshot of selling prices captured in dry-run before damage.
const PRICES: Record<string, number> = {
  "AMZ-ASHW-ZR-STRAW": 46.00,
  "AMZ-ASHW-ZR-STRAW-2": 80.50,
  "AMZ-BAG-1": 92.00,
  "AMZ-BAG-2F": 184.00,
  "AMZ-CREAM-CARAMEL": 80.50,
  "AMZ-CREAM-1": 80.50,
  "AMZ-CREAM-2F": 161.00,
  "AMZ-CREAM-CARAMEL-2": 161.00,
  "AMZ-CREAM-CR": 80.50,
  "AMZ-CREAMER-CR2": 161.00,
  "AMZ-INSTANTCO-HAZEL-2": 161.00,
  "AMZ-PODS-24": 92.00,
  "AMZ-PODS-24-2": 184.00,
  "AMZ-TABS-2F": 184.00,
  "AMZ-TABS-PM-2": 184.00,
  "AMZ-TABS-PMANGO": 92.00,
  "AMZ-TABS-SL": 92.00,
  "AMZ-TABS-SL-2": 184.00,
  "SF-ASHW10": 23.00,
};

function decrypt(encrypted: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  const [ivHex, tagHex, ctHex] = encrypted.split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return d.update(Buffer.from(ctHex, "hex")).toString("utf8") + d.final("utf8");
}

(async () => {
  console.log(`Mode: ${COMMIT ? "COMMIT" : "DRY-RUN"}`);
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

  for (const [sku, price] of Object.entries(PRICES)) {
    if (!COMMIT) { console.log(`would-restore ${sku} → $${price.toFixed(2)}`); continue; }
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
              our_price: [{ schedule: [{ value_with_tax: price }] }],
            },
          ],
        },
        {
          op: "replace",
          path: "/attributes/list_price",
          value: [{ value: price, currency: "USD", marketplace_id: conn.marketplace_id }],
        },
      ],
    };
    const url = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US`;
    const res = await fetch(url, { method: "PATCH", headers: { Authorization: `Bearer ${access_token}`, "x-amz-access-token": access_token, "Content-Type": "application/json" }, body: JSON.stringify(patchBody) });
    const data = await res.json().catch(() => null);
    const issues = ((data?.issues || []) as Array<{ severity: string; message: string }>).filter(i => i.severity === "ERROR");
    if (res.ok && issues.length === 0) {
      console.log(`${sku.padEnd(22)} restored=$${price.toFixed(2)}  submission=${data?.submissionId}`);
    } else {
      console.log(`${sku.padEnd(22)} ERROR  ${issues[0]?.message || `${res.status}: ${JSON.stringify(data).slice(0, 200)}`}`);
    }
  }
})();
