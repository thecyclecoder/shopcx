import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const SLUGS=["appstle-call-log-fetch-timeout-guard","error-feed-transient-auth-noise-never-escalate-chronic","db-investigate-timeouts-instance-rollback","box-self-update-freshness-anchors-to-boot-sha","tickets-awaiting-qc-workprobe-exclude-analyzer-locked"];
async function main(){const admin=createAdminClient();
 for(const slug of SLUGS){
   // ALL workspaces, exact slug
   const { data:exact }=await admin.from("specs").select("workspace_id,slug,status,intended_status,created_at").eq("slug",slug);
   // fuzzy — does a similar slug exist?
   const { data:like }=await admin.from("specs").select("slug,status").ilike("slug",`%${slug.slice(0,25)}%`).limit(5);
   console.log(`\n${slug}`);
   console.log(`  exact match rows (any ws): ${(exact??[]).length}  ${(exact??[]).map((r:any)=>`[${r.status??"derived"} ws=${String(r.workspace_id).slice(0,8)}]`).join(" ")}`);
   console.log(`  ilike("%first25%"): ${(like??[]).map((r:any)=>r.slug+"("+(r.status??"-")+")").join(", ")||"none"}`);
   // agent_jobs for this slug — what kinds?
   const { data:aj }=await admin.from("agent_jobs").select("kind,status,workspace_id").eq("spec_slug",slug).limit(5);
   console.log(`  agent_jobs: ${(aj??[]).map((j:any)=>j.kind+":"+j.status).join(", ")||"none"}`);
 }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
