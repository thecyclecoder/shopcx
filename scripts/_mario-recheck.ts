import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const admin=createAdminClient();
  const { data }=await admin.from("agent_jobs").select("status").eq("kind","mario").in("status",["queued","claimed","building"]);
  const c:Record<string,number>={}; for(const r of data||[]) c[r.status]=(c[r.status]||0)+1;
  console.log("active mario now:", JSON.stringify(c), "total", (data||[]).length);
})().then(()=>process.exit(0));
