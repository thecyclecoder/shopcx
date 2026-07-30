import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ID="4ca3fe6e";
(async()=>{
  const admin=createAdminClient();
  const {data:c}=await admin.from("ad_campaigns").select("id,name,angle_id,status").eq("workspace_id",WS).ilike("id",`${ID}%`).maybeSingle();
  if(!c){console.log("creative not found");return;}
  const {error}=await admin.from("ad_campaigns").update({status:"draft"}).eq("id",(c as any).id);
  console.log(error?`ERR ${error.message}`:`✓ moved to draft: ${(c as any).name} (${(c as any).id.slice(0,8)}) — was ready+null-angle`);
  // verify no Dahlia-competitor null-angle ready remains
  const {data:ready}=await admin.from("ad_campaigns").select("id,name,angle_id").eq("workspace_id",WS).eq("status","ready");
  const dn=(ready||[]).filter((r:any)=>!r.angle_id && /dahlia.*competitor/i.test(r.name||"")).length;
  console.log(`Dahlia-competitor null-angle ready remaining: ${dn}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
