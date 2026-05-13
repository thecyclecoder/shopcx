// One-off backfill: link amazon_asins rows to Shopify products by
// matching the ASIN title against product titles (case-insensitive
// substring match). Best-effort — admin can review + correct via
// the dashboard once we add the mapping UI.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods

// 1) Load all products in the workspace, sorted longest-title-first so
// "Amazing Coffee K-Cups" matches before "Amazing Coffee".
const { data: products } = await admin
  .from("products")
  .select("id, title")
  .eq("workspace_id", WORKSPACE_ID)
  .eq("status", "active");
const sortedProducts = (products || []).sort(
  (a, b) => (b.title?.length || 0) - (a.title?.length || 0),
);

// 2) Pull every unlinked ASIN
const { data: asins } = await admin
  .from("amazon_asins")
  .select("id, asin, sku, title, product_id")
  .eq("workspace_id", WORKSPACE_ID)
  .is("product_id", null);

console.log(`Products: ${sortedProducts.length}`);
console.log(`Unlinked ASINs: ${asins?.length || 0}\n`);

// Match heuristics — K-Cups / Pods variants of Amazing Coffee go to
// the K-Cups product when those keywords appear; otherwise pick the
// longest-title product whose title is contained in the ASIN title.
function matchProduct(asinTitle) {
  const t = (asinTitle || "").toLowerCase();
  // K-Cups detection — both "k-cup" and "pods" common in ASIN titles
  const isKcups = /k[\s-]?cup|pods?/.test(t);

  for (const p of sortedProducts) {
    const pt = (p.title || "").toLowerCase();
    if (!pt) continue;
    if (t.includes(pt)) {
      // Prefer the K-Cups version of a product when the ASIN looks
      // like K-Cups and we just matched the non-K-Cups product.
      if (isKcups && !pt.includes("k-cup") && !pt.includes("pods")) {
        const kcupVariant = sortedProducts.find(
          (q) =>
            q.title.toLowerCase().includes(pt) &&
            /k[\s-]?cup|pods?/.test(q.title.toLowerCase()),
        );
        if (kcupVariant) return kcupVariant;
      }
      return p;
    }
  }
  return null;
}

const updates = [];
for (const a of asins || []) {
  const p = matchProduct(a.title);
  if (p) {
    updates.push({ id: a.id, sku: a.sku, title: a.title, product_id: p.id, product_title: p.title });
  }
}

console.log(`Matched ${updates.length} of ${asins?.length || 0} ASINs:`);
for (const u of updates) {
  console.log(`  ${u.sku.padEnd(28)} → ${u.product_title}`);
}

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  console.log("\n(dry-run, no writes)");
  process.exit(0);
}

console.log("\nWriting product_id links…");
for (const u of updates) {
  const { error } = await admin
    .from("amazon_asins")
    .update({ product_id: u.product_id })
    .eq("id", u.id);
  if (error) console.error(`  fail: ${u.sku} — ${error.message}`);
}
console.log("Done.");
