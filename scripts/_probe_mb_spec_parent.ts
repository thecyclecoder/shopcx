import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const { data } = await admin.from("specs")
    .select("slug, owner, parent_kind, parent_ref, milestone_id, parent")
    .eq("workspace_id",WS)
    .in("slug",["media-buyer-test-winner-loop","media-buyer-product-scoped-test-rail","media-buyer-sensor-trust-probe"]);
  for(const s of (data||[]) as any[]) console.log(JSON.stringify(s,null,1));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
