import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PRODUCT_ID = "ea433e56-0aa4-4b46-9107-feb11f77f533";

// Count by status
const statuses = ["published", "featured", "pending", "unpublished", "rejected"];
console.log("BY STATUS:");
for (const s of statuses) {
  const { count } = await admin
    .from("product_reviews")
    .select("id", { count: "exact", head: true })
    .eq("product_id", PRODUCT_ID)
    .eq("status", s);
  console.log(`  status="${s}": ${count}`);
}

// Count by featured boolean
const { count: featuredTrue } = await admin
  .from("product_reviews")
  .select("id", { count: "exact", head: true })
  .eq("product_id", PRODUCT_ID)
  .eq("featured", true);
const { count: featuredFalse } = await admin
  .from("product_reviews")
  .select("id", { count: "exact", head: true })
  .eq("product_id", PRODUCT_ID)
  .eq("featured", false);
const { count: featuredNull } = await admin
  .from("product_reviews")
  .select("id", { count: "exact", head: true })
  .eq("product_id", PRODUCT_ID)
  .is("featured", null);

console.log("\nBY featured COLUMN:");
console.log(`  featured=true:  ${featuredTrue}`);
console.log(`  featured=false: ${featuredFalse}`);
console.log(`  featured=null:  ${featuredNull}`);

// Cross-check: status="featured" but featured=false, or vice versa
const { count: mismatch1 } = await admin
  .from("product_reviews")
  .select("id", { count: "exact", head: true })
  .eq("product_id", PRODUCT_ID)
  .eq("status", "featured")
  .neq("featured", true);
const { count: mismatch2 } = await admin
  .from("product_reviews")
  .select("id", { count: "exact", head: true })
  .eq("product_id", PRODUCT_ID)
  .eq("featured", true)
  .neq("status", "featured");

console.log("\nMISMATCHES:");
console.log(`  status="featured" but featured!=true: ${mismatch1}`);
console.log(`  featured=true but status!="featured": ${mismatch2}`);

// Top-24 sample — what does the page actually load?
const { data: top24 } = await admin
  .from("product_reviews")
  .select("id, status, featured, rating, title")
  .eq("product_id", PRODUCT_ID)
  .in("status", ["published", "featured"])
  .not("body", "is", null)
  .order("featured", { ascending: false })
  .order("rating", { ascending: false })
  .order("created_at", { ascending: false })
  .limit(24);

console.log("\nTOP 24 LOADED ON PAGE (current ordering):");
let featCount = 0;
for (const r of top24 || []) {
  if (r.featured === true) featCount++;
}
console.log(`  Of 24 loaded: ${featCount} have featured=true, ${24 - featCount} are non-featured`);
