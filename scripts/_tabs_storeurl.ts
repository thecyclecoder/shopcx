import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("creative_skeletons")
    .select("advertiser,hook,days_running,has_store_url,ads_type,call_to_action")
    .eq("workspace_id",WS).eq("product_id",TABS).eq("status","analyzed").not("hook","is",null).gte("days_running",45)
    .order("days_running",{ascending:false}).limit(24);
  for(const r of (data??[]) as any[]){
    const bad = r.advertiser==="Live It Up LLC" ? "❌APPLIANCE" : "✅supp";
    console.log(`${bad} store=${String(r.has_store_url).padEnd(5)} type=${String(r.ads_type??"?").slice(0,10).padEnd(10)} cta=${String(r.call_to_action??"?").slice(0,14).padEnd(14)} [${(r.advertiser??"").slice(0,16).padEnd(16)}] ${String(r.hook).slice(0,32)}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
