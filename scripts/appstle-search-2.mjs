// More Appstle endpoint guesses for finding a contract by Shopify customer.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, ENCRYPTION_KEY } from "./env.mjs";
import { createDecipheriv } from "crypto";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SHOPIFY_CUSTOMER_ID = process.argv[2] || "8457631137965";
const EMAIL = process.argv[3] || "sparkle4536@yahoo.com";

function decrypt(encrypted) {
  const [ivHex, tagHex, cipherHex] = encrypted.split(":");
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(cipherHex, "hex")).toString("utf8") + decipher.final("utf8");
}

const { data: ws } = await admin
  .from("workspaces")
  .select("appstle_api_key_encrypted, shopify_myshopify_domain")
  .eq("id", W)
  .single();
const apiKey = decrypt(ws.appstle_api_key_encrypted);
const shop = ws.shopify_myshopify_domain;

const headers = { "X-API-Key": apiKey, Accept: "application/json" };

const candidates = [
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/customer-search?customerId=${SHOPIFY_CUSTOMER_ID}&shop=${shop}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/active?customerId=${SHOPIFY_CUSTOMER_ID}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-customers?email=${encodeURIComponent(EMAIL)}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-customers/by-email/${encodeURIComponent(EMAIL)}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-customers/${SHOPIFY_CUSTOMER_ID}`,
  `https://subscription-admin.appstle.com/api/external/v2/customers/${SHOPIFY_CUSTOMER_ID}/contracts`,
  `https://subscription-admin.appstle.com/api/external/v2/customer-portal/subscription-contracts?customerId=${SHOPIFY_CUSTOMER_ID}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-search?customerId=${SHOPIFY_CUSTOMER_ID}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-search?email=${encodeURIComponent(EMAIL)}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-by-email?email=${encodeURIComponent(EMAIL)}`,
];

for (const url of candidates) {
  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    const status = res.status;
    if (status === 200 || status === 204) {
      console.log(`\n✓ ${status}  ${url}`);
      console.log(body.slice(0, 500));
    } else {
      console.log(`  ${status}  ${url}`);
    }
  } catch (e) {
    console.log(`  ERR  ${url}  ${e.message}`);
  }
}
