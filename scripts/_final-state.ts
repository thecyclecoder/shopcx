import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("status,spec_slug,updated_at").order("updated_at",{ascending:false}).limit(6);
  console.log("=== most recent job activity ===");
  for(const j of jobs||[]) console.log(`${(j as any).updated_at?.slice(11,19)} [${(j as any).status}] ${(j as any).spec_slug||""}`);
  // backfill + AP specific
  for(const [slug,id] of [["backfill","be78ec7a-02d9-4fd8-a054-5feade6a705a"],["AP","f984a9fb-6eac-4518-ba29-c9db7f1eaa7d"]]){
    const {data:j}=await db.from("agent_jobs").select("status,pending_actions").eq("id",id).maybeSingle();
    const pa=(j as any)?.pending_actions||[];
    const pend=pa.filter((a:any)=>(a.status||"pending")==="pending").length;
    console.log(`${slug}: status=${(j as any)?.status} | pending=${pend}/${pa.length}`);
  }
  process.exit(0);
})();
