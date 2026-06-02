import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: p } = await admin.from("products").select("*").limit(1);
  console.log("products columns:", Object.keys(p?.[0] || {}).sort());
  const { data: v } = await admin.from("product_variants").select("*").limit(1);
  console.log("\nproduct_variants columns:", Object.keys(v?.[0] || {}).sort());
}
main();
