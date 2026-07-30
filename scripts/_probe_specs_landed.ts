import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const { data } = await admin.from("specs").select("slug, status, owner").eq("workspace_id",WS)
    .in("slug",["media-buyer-replenish-per-product-scope","media-buyer-kill-on-decision-tree-retire-roas-floor"]);
  for(const s of (data||[]) as any[]) console.log(`  [${s.status}] ${s.slug} (owner ${s.owner})`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,150));process.exit(1);});
