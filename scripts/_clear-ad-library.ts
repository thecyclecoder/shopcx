import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { count:before }=await a.from("creative_skeletons").select("id",{count:"exact",head:true}).eq("workspace_id",WS);
  const { error }=await a.from("creative_skeletons").delete().eq("workspace_id",WS);
  if(error){ console.error("clear failed:", error.message); process.exit(1); }
  const { count:after }=await a.from("creative_skeletons").select("id",{count:"exact",head:true}).eq("workspace_id",WS);
  console.log(`cleared ad library: ${before} → ${after} rows`);
})().then(()=>process.exit(0));
