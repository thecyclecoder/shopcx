import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Both Amazing Coffee + Amazing Coffee K-Cups products and their variants.
const { data: products } = await admin
  .from("products")
  .select("id, title")
  .ilike("title", "%amazing coffee%");

for (const p of products || []) {
  console.log(`\n${p.title}  (${p.id})`);
  const { data: variants } = await admin
    .from("product_variants")
    .select("id, title, sku, position, option1, option2, option3")
    .eq("product_id", p.id)
    .order("position", { ascending: true });
  for (const v of variants || []) {
    console.log(
      `  pos=${v.position} title="${v.title}" sku=${v.sku} opt1=${v.option1}`,
    );
  }
}
