import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data: prompts } = await admin
  .from("sonnet_prompts")
  .select("id, category, title, content, enabled, sort_order")
  .eq("workspace_id", W)
  .order("category", { ascending: true })
  .order("sort_order", { ascending: true });

console.log(`Total: ${prompts?.length} prompts\n`);

const byCategory = {};
for (const p of prompts || []) {
  byCategory[p.category] = byCategory[p.category] || [];
  byCategory[p.category].push(p);
}

for (const [cat, list] of Object.entries(byCategory)) {
  console.log(`\n========== ${cat.toUpperCase()} (${list.length}) ==========\n`);
  for (const p of list) {
    console.log(`[${p.sort_order}${p.enabled ? "" : " DISABLED"}] ${p.title}  (${p.id.slice(0,8)})`);
    console.log(p.content);
    console.log("");
    console.log("---");
    console.log("");
  }
}
