// Probe Appstle for an active subscription contract belonging to the
// given Shopify customer ID. Tries a few likely endpoint shapes since
// the search endpoint isn't documented in our APPSTLE.md.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, ENCRYPTION_KEY } from "./env.mjs";
import { createDecipheriv } from "crypto";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SHOPIFY_CUSTOMER_ID = process.argv[2] || "8457631137965";

// Decrypt Appstle credentials — format "ivHex:tagHex:ciphertextHex"
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
console.log("shop:", shop);

const headers = { "X-API-Key": apiKey, Accept: "application/json" };

// Endpoint candidates
const candidates = [
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/by-customer?customerId=${SHOPIFY_CUSTOMER_ID}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/customer/${SHOPIFY_CUSTOMER_ID}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts?customerId=${SHOPIFY_CUSTOMER_ID}&page=0&size=20`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts?customerId=${SHOPIFY_CUSTOMER_ID}`,
  `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/by-shopify-customer?shopifyCustomerId=${SHOPIFY_CUSTOMER_ID}`,
];

for (const url of candidates) {
  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    console.log(`\n${url}\n  -> ${res.status}  ${body.slice(0, 250)}`);
  } catch (e) {
    console.log(`\n${url}\n  -> ERROR ${e.message}`);
  }
}
