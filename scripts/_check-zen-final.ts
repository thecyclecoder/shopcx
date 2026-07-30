import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const NEW_CAMP="120249298361370682";
const GRAPH="https://graph.facebook.com/v21.0";
async function gget(path:string,params:Record<string,string>,token:string){const u=new URL(`${GRAPH}/${path}`);for(const[k,v]of Object.entries(params))u.searchParams.append(k,v);u.searchParams.append("access_token",token);const r=await fetch(u);return r.json();}
async function main(){
  const admin=createAdminClient();
  const token=await getMetaUserToken(WS);
  const nc=await gget(`${NEW_CAMP}/adsets`,{fields:"id,name,effective_status"},token!);
  console.log("new Zen campaign adsets:");
  for(const a of (nc.data??[])) console.log(`   [${a.effective_status}] ${a.name}`);
  const { data: coh } = await admin.from("media_buyer_test_cohorts").select("product_id, test_meta_campaign_id").eq("id","a2c760ca-a16a-42bb-8622-c9a9aa047d13").maybeSingle();
  console.log("\nZen cohort now:", JSON.stringify(coh));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
