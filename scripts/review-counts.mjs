import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PRODUCT_ID = "ea433e56-0aa4-4b46-9107-feb11f77f533";

const { count: totalPub } = await admin
  .from("product_reviews")
  .select("id", { count: "exact", head: true })
  .eq("product_id", PRODUCT_ID)
  .in("status", ["published", "featured"]);

const { count: totalAll } = await admin
  .from("product_reviews")
  .select("id", { count: "exact", head: true })
  .eq("product_id", PRODUCT_ID);

const { count: hasBody } = await admin
  .from("product_reviews")
  .select("id", { count: "exact", head: true })
  .eq("product_id", PRODUCT_ID)
  .in("status", ["published", "featured"])
  .not("body", "is", null);

console.log(`Total reviews (all status): ${totalAll}`);
console.log(`Published+featured:         ${totalPub}`);
console.log(`Published+featured w/body:  ${hasBody}`);

// Phrase coverage across ALL reviews with body
const { data: allReviews } = await admin
  .from("product_reviews")
  .select("id, body")
  .eq("product_id", PRODUCT_ID)
  .in("status", ["published", "featured"])
  .not("body", "is", null);

const phrases = {
  "Weight Loss": ["I lost 5 pounds", "curbs my appetite", "helps curb my appetite", "lost weight", "weight loss", "curb my appetite", "appetite suppressant"],
  "Energy & Performance": ["gives me energy without the jitters", "no jitters", "energy without the caffeine jitters", "gives me the perfect amount of energy", "great energy without the crash", "sustained energy without the crash", "good clean energy boost with no crash after", "energy and clarity", "more energy without jitters"],
  "Mental Clarity & Focus": ["reduces brain fog", "mental clarity", "helps me focus"],
  "Digestive Health": ["doesn't bother my stomach at all", "helping me with my digestive system", "Amazing to the Digestive System"],
  "Great Taste": ["tastes great", "great taste", "delicious"],
  "Natural Superfood Ingredients": ["all natural ingredients", "natural herbs and other natural ingredients", "packed with super foods"],
};

console.log("\nFULL-CORPUS COVERAGE (all reviews with body):");
console.log("─".repeat(60));
for (const [benefit, ps] of Object.entries(phrases)) {
  const lowers = ps.map((p) => p.toLowerCase());
  let count = 0;
  for (const r of allReviews || []) {
    const body = (r.body || "").toLowerCase();
    if (lowers.some((p) => body.includes(p))) count++;
  }
  console.log(`  ${count.toString().padStart(4)}  ${benefit}`);
}
