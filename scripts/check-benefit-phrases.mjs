import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PRODUCT_ID = "ea433e56-0aa4-4b46-9107-feb11f77f533";

const { data: benefits } = await admin
  .from("product_benefit_selections")
  .select("benefit_name, role, customer_phrases, display_order")
  .eq("product_id", PRODUCT_ID)
  .in("role", ["lead", "supporting"])
  .order("display_order");

console.log("BENEFIT SELECTIONS:");
for (const b of benefits || []) {
  console.log(`\n  ${b.benefit_name} [${b.role}]`);
  console.log(`    customer_phrases:`, JSON.stringify(b.customer_phrases));
}

const { data: ra } = await admin
  .from("product_review_analysis")
  .select("top_benefits, most_powerful_phrases, reviews_analyzed_count")
  .eq("product_id", PRODUCT_ID)
  .maybeSingle();

console.log("\n\nREVIEW ANALYSIS:");
console.log("  reviews_analyzed_count:", ra?.reviews_analyzed_count);
console.log("  top_benefits:", JSON.stringify(ra?.top_benefits, null, 2));
console.log("  most_powerful_phrases (first 5):", JSON.stringify((ra?.most_powerful_phrases || []).slice(0, 5), null, 2));

// Sample a few reviews to see typical body language
const { data: reviews } = await admin
  .from("product_reviews")
  .select("body")
  .eq("product_id", PRODUCT_ID)
  .in("status", ["published", "featured"])
  .not("body", "is", null)
  .limit(8);

console.log("\n\nSAMPLE REVIEW BODIES:");
for (const r of reviews || []) {
  console.log(`  • ${(r.body || "").slice(0, 200).replace(/\n/g, " ")}`);
}
