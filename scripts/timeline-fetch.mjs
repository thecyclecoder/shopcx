import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: products } = await admin
  .from("products")
  .select("id, title, workspace_id")
  .ilike("title", "%amazing coffee%");

console.log("Matching products:");
for (const p of products || []) {
  console.log(`  ${p.id} — ${p.title} — ws=${p.workspace_id}`);
}

for (const p of products || []) {
  const { data: rows } = await admin
    .from("product_page_content")
    .select("id, version, status, expectation_timeline")
    .eq("product_id", p.id)
    .order("version", { ascending: false });
  console.log(`\nproduct_page_content rows for ${p.title}:`);
  for (const r of rows || []) {
    console.log(`  v${r.version} [${r.status}] id=${r.id}`);
    console.log("    timeline:", JSON.stringify(r.expectation_timeline, null, 2));
  }
}
