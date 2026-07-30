import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  for(const id of ["b683d0a8-937f-45fb-970f-0cc890b6d21c","ad04a3d1-4a79-4516-8824-170fb140a760"]){
    const {data:c,error}=await admin.from("ad_campaigns").select("*").eq("id",id).maybeSingle();
    if(error){ console.log(id,"ERR",error.message); continue; }
    if(!c){ console.log(id,"— not in ad_campaigns; trying meta_campaigns/test_campaigns"); 
      const {data:t}=await admin.from("ad_test_campaigns").select("*").eq("id",id).maybeSingle().then((r:any)=>r,()=>({data:null}));
      console.log("  test_campaign:", t?JSON.stringify(t).slice(0,300):"none"); continue; }
    console.log(`\n▸ ${id}`);
    console.log("  keys:", Object.keys(c).join(","));
    console.log("  status:", c.status, "| angle_id:", c.angle_id, "| product_id:", c.product_id, "| name:", c.name||c.campaign_name);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
