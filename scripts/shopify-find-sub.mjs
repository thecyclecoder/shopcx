// Query Shopify GraphQL for active subscription contracts on a customer.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, ENCRYPTION_KEY } from "./env.mjs";
import { createDecipheriv } from "crypto";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SHOPIFY_CUSTOMER_ID = process.argv[2] || "8457631137965";

function decrypt(encrypted) {
  const [ivHex, tagHex, cipherHex] = encrypted.split(":");
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(cipherHex, "hex")).toString("utf8") + decipher.final("utf8");
}

const { data: ws } = await admin
  .from("workspaces")
  .select("shopify_myshopify_domain, shopify_access_token_encrypted")
  .eq("id", W)
  .single();
const accessToken = decrypt(ws.shopify_access_token_encrypted);
const shop = ws.shopify_myshopify_domain;

const query = `
  query CustomerSubs($id: ID!) {
    customer(id: $id) {
      id
      email
      firstName
      lastName
      subscriptionContracts(first: 20) {
        edges {
          node {
            id
            status
            nextBillingDate
            createdAt
            billingPolicy { interval intervalCount }
            lines(first: 10) {
              edges {
                node {
                  title
                  variantTitle
                  quantity
                  productId
                  variantId
                  sku
                }
              }
            }
          }
        }
      }
    }
  }
`;

const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": accessToken,
  },
  body: JSON.stringify({
    query,
    variables: { id: `gid://shopify/Customer/${SHOPIFY_CUSTOMER_ID}` },
  }),
});
const json = await res.json();
if (json.errors) {
  console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
  process.exit(1);
}
const customer = json.data.customer;
if (!customer) {
  console.log("No customer found for", SHOPIFY_CUSTOMER_ID);
  process.exit(0);
}

console.log(`Customer: ${customer.firstName} ${customer.lastName} <${customer.email}>`);
const contracts = customer.subscriptionContracts.edges.map((e) => e.node);
console.log(`\nFound ${contracts.length} subscription contract(s):\n`);
for (const c of contracts) {
  const numericId = c.id.replace("gid://shopify/SubscriptionContract/", "");
  console.log(`  Contract ${numericId}`);
  console.log(`    status:      ${c.status}`);
  console.log(`    next billing: ${c.nextBillingDate}`);
  console.log(`    created:     ${c.createdAt}`);
  console.log(`    interval:    every ${c.billingPolicy.intervalCount} ${c.billingPolicy.interval}`);
  console.log(`    lines:`);
  for (const line of c.lines.edges.map((e) => e.node)) {
    const vid = line.variantId?.replace("gid://shopify/ProductVariant/", "");
    console.log(`      - ${line.title} ${line.variantTitle ? `(${line.variantTitle})` : ""} qty=${line.quantity} variant=${vid} sku=${line.sku}`);
  }
  console.log("");
}
