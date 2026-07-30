import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
async function main(){const admin=createAdminClient();
 const { data:jobs }=await admin.from("agent_jobs").select("id,spec_slug,status,instructions,log_tail,created_by").eq("kind","mario").order("created_at",{ascending:false}).limit(2);
 for(const j of (jobs??[]) as any[]){
   console.log(`\n======== mario job ${String(j.id).slice(0,8)} slug=${j.spec_slug} created_by=${j.created_by??"-"} ========`);
   console.log("--- INSTRUCTIONS (what the detector dispatched him for) ---");
   console.log(String(j.instructions??"(none)").slice(0,1200));
   console.log("\n--- log_tail (last 6 lines) ---");
   console.log(String(j.log_tail??"").split("\n").filter(Boolean).slice(-6).join("\n"));
 }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
