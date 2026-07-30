import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";
async function main(){
  const admin=createAdminClient();
  const {data,error}=await admin.from("creative_skeletons")
    .select("id,advertiser,hook,days_running")
    .eq("workspace_id",WS).eq("product_id",TABS).eq("status","analyzed")
    .not("hook","is",null).gte("days_running",45)
    .order("days_running",{ascending:false}).limit(30);
  if(error){console.error("ERR",error.message);return;}
  console.log(`analyzed+dr>=45: ${(data??[]).length}`);
  for(const r of (data??[]) as any[]){
    console.log(`dr=${String(r.days_running).padStart(4)} [${(r.advertiser??"?").slice(0,24).padEnd(24)}] ${String(r.hook).slice(0,58)}`);
  }
  // find appliance
  const {data:app}=await admin.from("creative_skeletons")
    .select("id,advertiser,hook,days_running,status")
    .eq("workspace_id",WS).eq("product_id",TABS).ilike("hook","%appliance%");
  console.log(`\n"appliance" rows: ${(app??[]).length}`);
  for(const r of (app??[]) as any[]) console.log(`  ${r.id} [${r.advertiser}] dr=${r.days_running} st=${r.status} :: ${r.hook}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
