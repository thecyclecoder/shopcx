import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MEMBERS=["spec-timecard-ledger-and-sdk","spec-timecard-chokepoint-instrumentation","mario-stall-detector-cron-and-thresholds","mario-reactive-box-agent","spec-detail-timecard-timeline"];
async function main(){const admin=createAdminClient();
 const { data:g }=await admin.from("goals").select("slug,status,main_merge_sha,promotion_held_reason,updated_at").eq("workspace_id",WS).eq("slug","mario-pipeline-plumbing").single();
 console.log("=== GOAL ===");
 console.log(`status=${(g as any).status}  main_merge_sha=${(g as any).main_merge_sha??"NULL (not on main)"}  held=${(g as any).promotion_held_reason??"-"}`);
 console.log("\n=== MEMBER SPECS: phase ship state ===");
 for(const slug of MEMBERS){
   const { data:s }=await admin.from("specs").select("id,goal_branch_sha,last_merge_sha,merged_pr").eq("workspace_id",WS).eq("slug",slug).single();
   const { data:ph }=await admin.from("spec_phases").select("status,merge_sha").eq("spec_id",(s as any).id);
   const rows=(ph??[]) as any[];
   const shipped=rows.filter(p=>p.status==="shipped").length;
   const onMain=rows.filter(p=>p.merge_sha).length;
   console.log(`  ${slug}: phases ${shipped}/${rows.length} shipped, ${onMain} with main merge_sha  goal_branch_sha=${(s as any).goal_branch_sha?"set":"-"}  merged_pr=${(s as any).merged_pr??"-"}`);
 }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
