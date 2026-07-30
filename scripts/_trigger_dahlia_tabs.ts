import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";
async function main() {
  const admin = createAdminClient();
  const { data: job, error } = await admin.from("agent_jobs").insert({
    workspace_id: WS, kind: "ad-creative", status: "queued",
    spec_slug: `ad-creative:${TABS}`,
    instructions: JSON.stringify({ product_id: TABS, count: 4 }),
  }).select("id,status,created_at").single();
  if (error) { console.error("insert error:", error); return; }
  console.log("enqueued tabs job:", JSON.stringify(job));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
