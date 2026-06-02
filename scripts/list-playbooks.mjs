import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// Discover columns first
const { data: sample, error } = await admin.from("playbooks").select("*").limit(1);
if (error) console.log("err:", error);
else console.log("playbooks columns:", Object.keys(sample?.[0] || {}).join(", "));

const { data: playbooks } = await admin
  .from("playbooks")
  .select("*")
  .eq("workspace_id", W);

console.log(`\n${playbooks?.length} playbooks:`);
for (const p of playbooks || []) {
  const intents = p.trigger_intents || p.triggers || "?";
  console.log(`  ${p.is_active ? "✓" : "✗"} "${p.name}"  slug=${p.slug || "—"}  intents=${JSON.stringify(intents)}`);
}
