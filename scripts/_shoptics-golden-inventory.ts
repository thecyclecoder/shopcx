import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";

// Read Shoptics DB creds from its .env.local (read-only golden snapshot).
const envText = fs.readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8");
const env: Record<string, string> = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const shoptics = createClient(url, key, { auth: { persistSession: false } });

const TABLES = [
  "products", "product_bom", "sku_mappings", "external_skus", "kit_mappings",
  "qb_account_mappings", "gateway_mappings", "shipping_protection_products",
  "manual_inventory", "unmapped_skus", "revenue accounts?",
  "month_end_closings", "payment_processor_summaries",
  "amazon_inventory_snapshots", "tpl_inventory_snapshots", "amazon_sales_snapshots",
  "shopify_sales_snapshots", "internal_sales_snapshots", "sale_records", "cron_logs",
];

async function main() {
  console.log("Shoptics DB:", url);
  for (const t of TABLES) {
    if (t.includes("?")) continue;
    const { count, error } = await shoptics.from(t).select("*", { count: "exact", head: true });
    console.log(`  ${t.padEnd(32)} ${error ? "ERR " + error.message : (count ?? 0) + " rows"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
