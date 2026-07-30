import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
const { data }=await admin.from("director_activity").select("action_kind,reason,created_at,metadata").eq("workspace_id",WS).eq("spec_slug","mario-reactive-box-agent").order("created_at",{ascending:false}).limit(8);
for(const a of (data??[]) as any[]) console.log(`[${a.created_at}] ${a.action_kind}\n   ${String(a.reason??"").slice(0,220)}\n   meta=${JSON.stringify(a.metadata??{}).slice(0,200)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
