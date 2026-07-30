import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:goals }=await admin.from("goals").select("slug,status,main_merge_sha").eq("workspace_id",WS).in("status",["greenlit","in_progress"]);
  console.log("active goals:", (goals||[]).map(g=>`${g.slug}(${g.status})`).join(", "));
})().then(()=>process.exit(0));
