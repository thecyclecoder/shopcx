import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data: pbs } = await admin.from("playbooks")
  .select("id, name, slug, trigger_intents, is_active, description")
  .eq("workspace_id", W).eq("is_active", true);

console.log(`${pbs?.length || 0} active playbooks:\n`);
for (const p of pbs || []) {
  console.log(`  ${p.name}`);
  console.log(`    slug: ${p.slug}`);
  console.log(`    triggers: ${JSON.stringify(p.trigger_intents)}`);
  console.log(`    desc: ${(p.description || "").slice(0, 100)}\n`);
}
