import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const filter = (process.argv[2] || "").toLowerCase();

const { data: prompts } = await admin
  .from("sonnet_prompts")
  .select("id, category, title, content, enabled, sort_order")
  .eq("workspace_id", W)
  .order("category, sort_order");

const matched = filter
  ? prompts.filter(p => p.title.toLowerCase().includes(filter) || p.content.toLowerCase().includes(filter))
  : prompts;

console.log(`${matched.length} prompts${filter ? ` matching "${filter}"` : ""}:\n`);
for (const p of matched) {
  console.log(`[${p.category}/${p.sort_order}${p.enabled ? "" : "/DISABLED"}] ${p.title}`);
  console.log(`  ${p.content.slice(0, 400)}${p.content.length > 400 ? "..." : ""}`);
  console.log();
}
