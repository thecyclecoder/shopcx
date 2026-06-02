import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data: rows } = await admin
  .from("dashboard_notifications")
  .select("id, title, created_at")
  .eq("workspace_id", W)
  .or("metadata->>type.eq.ai_nightly_analysis,metadata->>type.eq.ai_action_item");

console.log(`Found ${rows?.length || 0} ai_nightly_analysis / ai_action_item notification(s) to delete:`);
for (const r of rows || []) console.log(`  ${r.created_at}  ${r.title}`);

if (process.argv.includes("--apply")) {
  if (rows?.length) {
    await admin.from("dashboard_notifications").delete().in("id", rows.map(r => r.id));
    console.log(`\n✓ deleted ${rows.length} row(s)`);
  }
} else {
  console.log("\nDry run — re-run with --apply.");
}
