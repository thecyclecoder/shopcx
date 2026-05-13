import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PRODUCT_ID = "ea433e56-0aa4-4b46-9107-feb11f77f533"; // Amazing Coffee

const { data: linked } = await admin
  .from("amazon_asins")
  .select("id, asin, sku, title, product_id, current_price_cents, list_price_cents, sale_price_cents, price_fetched_at")
  .eq("product_id", PRODUCT_ID);

console.log(`amazon_asins rows linked to Amazing Coffee (product_id=${PRODUCT_ID}):`);
for (const a of linked || []) {
  console.log(`  ${a.asin} sku=${a.sku} current=${a.current_price_cents} list=${a.list_price_cents} sale=${a.sale_price_cents} fetched=${a.price_fetched_at}`);
}
if (!linked?.length) console.log("  (none linked)");

// Also check if any rows have prices but no product_id link
const { data: anyPriced } = await admin
  .from("amazon_asins")
  .select("id, asin, sku, title, product_id, current_price_cents, price_fetched_at")
  .not("current_price_cents", "is", null)
  .limit(10);
console.log(`\nFirst 10 amazon_asins rows with cached prices (any product):`);
for (const a of anyPriced || []) {
  console.log(`  ${a.asin} sku=${a.sku} product_id=${a.product_id} current=${a.current_price_cents} title="${(a.title || '').slice(0, 40)}"`);
}
