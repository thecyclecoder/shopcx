import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("creative_skeletons")
    .select("advertiser,hook,days_running,destination_domain,landing_page_url")
    .eq("workspace_id",WS).eq("product_id",TABS).eq("status","analyzed").not("hook","is",null).gte("days_running",45)
    .neq("advertiser","Live It Up LLC")
    .order("days_running",{ascending:false}).limit(20);
  for(const r of (data??[]) as any[]){
    const dom=r.destination_domain??r.landing_page_url??"(null)";
    console.log(`[${(r.advertiser??"?").slice(0,20).padEnd(20)}] dr=${String(r.days_running).padStart(4)} dom=${String(dom).slice(0,40)}  :: ${String(r.hook).slice(0,40)}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
