import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const { data } = await admin.from("specs").select("slug, owner, parent_kind, parent_ref, milestone_id").eq("workspace_id",WS)
    .or("slug.ilike.%competitor%,slug.ilike.%scout%");
  for(const s of (data||[]) as any[]) console.log(`${s.slug} → owner=${s.owner} kind=${s.parent_kind} ref=${s.parent_ref} ms=${s.milestone_id?"yes":"-"}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,150));process.exit(1);});
