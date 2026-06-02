// Dump every sonnet_prompt that could be making us save before cancel
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data } = await admin.from("sonnet_prompts")
  .select("id, category, title, content, sort_order, enabled")
  .eq("workspace_id", W)
  .order("sort_order");

console.log(`Total prompts: ${data?.length || 0}\n`);

// Pull anything that mentions cancel/loyalty/pause/renewal/save
const KEYWORDS = ["cancel", "loyalty", "pause", "renewal", "save", "offer", "refund", "remedy", "first-renewal"];
for (const p of data || []) {
  const lc = (p.content || "").toLowerCase();
  if (KEYWORDS.some(k => lc.includes(k))) {
    console.log(`──── #${p.sort_order} [${p.category}] ${p.enabled ? "" : "(DISABLED) "}${p.title}`);
    console.log(`    id: ${p.id}`);
    console.log(`    ${p.content}\n`);
  }
}
