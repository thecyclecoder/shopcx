import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

const TARGETS = ["3000d52f-7004-4d50-8b5c-33d937a00d7d", "6a5d5df5-3945-439b-be15-82c0b33b1941"];

for (const id of TARGETS) {
  const { data: t } = await admin
    .from("tickets")
    .select("id, subject, channel")
    .eq("id", id)
    .single();
  console.log(`${id.slice(0, 8)}: channel=${t?.channel}  "${t?.subject?.slice(0, 60)}"`);
  if (!APPLY) continue;
  const { error } = await admin.from("tickets").update({ channel: "email" }).eq("id", id);
  if (error) console.log(`  ✗ ${error.message}`);
  else console.log("  ✓ updated to email");
}
if (!APPLY) console.log("\nDry run — re-run with --apply");
