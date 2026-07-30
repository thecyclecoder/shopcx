import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data:ready}=await admin.from("ad_campaigns").select("id,name,angle_id").eq("workspace_id",WS).eq("status","ready");
  const targets=(ready||[]).filter((r:any)=>!r.angle_id && /dahlia.*competitor/i.test(r.name||""));
  console.log(`Dahlia-competitor null-angle ready creatives to draft: ${targets.length}`);
  for(const c of targets as any[]){
    const {error}=await admin.from("ad_campaigns").update({status:"draft"}).eq("id",c.id);
    console.log(`  ${error?"ERR "+error.message:"✓ → draft"}: ${c.name} (${c.id.slice(0,8)})`);
  }
  const {data:after}=await admin.from("ad_campaigns").select("angle_id,name,status").eq("workspace_id",WS).eq("status","ready");
  const dn=(after||[]).filter((r:any)=>!r.angle_id && /dahlia.*competitor/i.test(r.name||"")).length;
  console.log(`remaining: ${dn}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
