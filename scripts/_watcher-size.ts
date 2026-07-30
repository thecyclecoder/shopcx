import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // count ready creatives with null angle_id, per product
  const {data:rows}=await admin.from("ad_campaigns").select("id,name,product_id,angle_id,status")
    .eq("workspace_id",WS).eq("status","ready");
  const nullAngle=(rows||[]).filter((r:any)=>!r.angle_id);
  console.log(`ready creatives: ${rows?.length} total, ${nullAngle.length} with NULL angle_id`);
  for(const r of nullAngle.slice(0,15)) console.log(`  ✗ ${r.name} (${r.id.slice(0,8)})`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
