import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ids = [
  "ea433e56-0aa4-4b46-9107-feb11f77f533", // Amazing Coffee (Instant)
  "f081a8ee-530b-4789-8654-bd57c3a51569", // Amazing Coffee K-Cups
];

const { data: variants } = await admin
  .from("product_variants")
  .select("product_id, id, title, position, supplement_facts")
  .in("product_id", ids)
  .not("supplement_facts", "is", null)
  .order("position", { ascending: true });

console.log(`Variants with supplement_facts across both products: ${variants?.length}`);
for (const v of variants || []) {
  console.log(`  product=${v.product_id} variant=${v.title} (pos=${v.position}, has_facts=${!!v.supplement_facts})`);
}

// Confirm the link group setup
const { data: linkRows } = await admin
  .from("product_link_members")
  .select("group_id, product_id")
  .in("product_id", ids);
console.log(`\nLink group memberships:`);
for (const r of linkRows || []) {
  console.log(`  group=${r.group_id} product=${r.product_id}`);
}
