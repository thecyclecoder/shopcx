#!/usr/bin/env npx tsx
/**
 * Refund a Braintree-paid Shopify order directly through the Braintree API,
 * then record a manual refund on the Shopify order. Use when Shopify's native
 * Braintree refund fails ("undefined method 'refund' for nil" / ID_NOT_FOUND).
 *
 * Run: npx tsx scripts/refund-via-braintree.ts <order_number_or_id> <amount_dollars> ["reason"]
 *   e.g. npx tsx scripts/refund-via-braintree.ts SC128233 79.48 "Honoring grandfathered price"
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ORDER = process.argv[2];
const AMOUNT = process.argv[3];
const REASON = process.argv[4] || "Refund";
if (!ORDER || !AMOUNT) {
  console.error('Usage: npx tsx scripts/refund-via-braintree.ts <order_number_or_id> <amount_dollars> ["reason"]');
  process.exit(1);
}
const amountCents = Math.round(parseFloat(AMOUNT) * 100);

(async () => {
  const { refundOrderViaBraintree } = await import("@/lib/shopify-order-actions");
  console.log(`Refunding $${(amountCents / 100).toFixed(2)} on ${ORDER} via Braintree…`);
  const r = await refundOrderViaBraintree(WORKSPACE_ID, ORDER, amountCents, REASON);
  console.log(JSON.stringify(r, null, 2));
  if (!r.success) process.exit(1);
})();
