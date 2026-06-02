import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data: row } = await admin
  .from("sonnet_prompts")
  .select("id, title, content")
  .eq("workspace_id", W)
  .eq("title", "Account linking")
  .maybeSingle();
if (!row) { console.log("Not found — already removed?"); process.exit(0); }
console.log(`Deleting old short rule (${row.id}): "${row.content.slice(0, 100)}…"`);
await admin.from("sonnet_prompts").delete().eq("id", row.id);
console.log("✓ Deleted");
